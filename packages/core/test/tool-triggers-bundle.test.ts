import { expect, describe, spyOn } from "bun:test"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@orchestra/core/effect/app-node-builder"
import { LayerNode } from "@orchestra/util/effect/layer-node"
import { makeLocationNode } from "@orchestra/util/effect/app-node"
import { KV } from "@orchestra/core/kv"
import { Orchestra } from "@orchestra/core/orchestra"
import { Session } from "@orchestra/core/session"
import { Tool } from "@orchestra/core/tool"
import { BrowserRuntime } from "@orchestra/core/browser/runtime"
import { Trigger } from "@orchestra/core/trigger"
import { TriggersTool } from "@orchestra/core/tool/plugin/triggers"
import { Global } from "@orchestra/util/global"
import { tempGlobalLayer } from "./fixture/global"
import { withTempDir } from "./fixture/tmpdir"
import { orchestraLayer } from "./lib/orchestra"
import { it } from "./lib/effect"
import { executeTool, registerToolPlugin, toolIdentity } from "./lib/tool"
const main = Session.ID.make("ses_trigger_main")
const worker = Session.ID.make("ses_trigger_worker")
const plugin = makeLocationNode({
  name: "test/trigger-bundle-tool",
  layer: Layer.effectDiscard(registerToolPlugin(TriggersTool.Plugin)),
  deps: [Tool.node, KV.node, Orchestra.node, Session.node],
})
const run = (tools: Tool.Interface, input: Record<string, unknown>, sessionID = main) =>
  executeTool(tools, {
    sessionID,
    ...toolIdentity,
    call: { type: "tool-call" as const, id: `call_${crypto.randomUUID()}`, name: "triggers", input },
  })
const text = (value: { content?: readonly Tool.Content[] }) =>
  (value.content ?? []).flatMap((item) => (item.type === "text" ? [item.text] : [])).join("\n")
function harness(directory: string, triggered = false) {
  return AppNodeBuilder.build(LayerNode.group([Tool.node, KV.node, plugin]), [
    Global.node.replace(tempGlobalLayer),
    Orchestra.node.replace(
      orchestraLayer({
        mainOf: (id) =>
          Effect.succeed(id === main ? ({ id: "prj_selected", main, directory } as Orchestra.Project) : undefined),
      }),
    ),
    Session.node.replace(
      Layer.mock(Session.Service, {
        messages: () =>
          Effect.succeed(triggered ? [{ type: "user", metadata: { source: "trigger", triggerID: "trg_parent" } }] : []),
      }),
    ),
  ])
}
describe("TriggersTool portable templates", () => {
  it.live("exports and saves only selected-project schedules, loads for review without changing live records", () =>
    withTempDir(({ path: directory }) =>
      Effect.gen(function* () {
        const kv = yield* KV.Service,
          tools = yield* Tool.Service
        const make = (projectID: string, id: string) => {
          const made = Trigger.create(
            { kind: "interval", spec: "10", prompt: "private prompt token CANARY" },
            { projectID, id, now: Date.now(), existing: 0 },
          )
          if (!made.ok) throw Error(made.error)
          return made.trigger
        }
        const original = make("prj_selected", "trg_own")
        yield* kv.set(Trigger.key("prj_selected", "trg_own"), original as never)
        yield* kv.set(Trigger.key("prj_other", "trg_foreign"), make("prj_other", "trg_foreign") as never)
        const exported = yield* run(tools, { action: "export", id: "trg_own" })
        expect(exported.status).toBe("completed")
        expect(JSON.parse(text(exported)).format).toBe("orchestra.trigger-bundle")
        expect(text(exported)).not.toContain("CANARY")
        expect((yield* run(tools, { action: "export", id: "trg_foreign" })).status).toBe("error")
        expect((yield* run(tools, { action: "save", id: "trg_own", templateName: "daily" })).status).toBe("completed")
        const file = yield* Effect.promise(() =>
          readFile(path.join(directory, ".orchestra", "triggers", "daily.json"), "utf8"),
        )
        expect(JSON.parse(file).templates[0].spec).toBe("10")
        expect(file).not.toContain("CANARY")
        expect((yield* run(tools, { action: "save", id: "trg_own", templateName: "daily" })).status).toBe("error")
        const loaded = yield* run(tools, { action: "load", templateName: "daily" })
        expect(loaded.status).toBe("completed")
        expect(text(loaded)).toContain("No trigger was registered or enabled")
        expect(yield* kv.get(Trigger.key("prj_selected", "trg_own"))).toEqual(original)
        expect((yield* kv.scan({ prefix: Trigger.PREFIX })).entries).toHaveLength(2)
        expect((yield* run(tools, { action: "load", templateName: "../daily" })).status).toBe("error")
        expect((yield* run(tools, { action: "load", templateName: "daily" }, worker)).status).toBe("error")
      }).pipe(Effect.provide(harness(directory))),
    ),
  )
  it.live("trigger-started turns cannot save or load templates to create a future instruction channel", () =>
    withTempDir(({ path: directory }) =>
      Effect.gen(function* () {
        const tools = yield* Tool.Service
        for (const action of ["save", "load", "export"]) {
          const result = yield* run(tools, { action, id: "trg_own", templateName: "daily" })
          expect(result.status).toBe("error")
          expect(result.error?.message).toContain("trigger")
        }
      }).pipe(Effect.provide(harness(directory, true))),
    ),
  )
  it.live("pause and delete release only the last enabled own browser watcher through actual tool execution", () =>
    withTempDir(({ path: directory }) =>
      Effect.gen(function* () {
        const kv = yield* KV.Service,
          tools = yield* Tool.Service
        const stopped: string[] = []
        const registry = spyOn(BrowserRuntime, "sessions").mockReturnValue([
          { id: "browser_own", name: "Fixture", project: directory, projectID: "prj_selected" },
        ])
        const stop = spyOn(BrowserRuntime, "stopPageWatcher").mockImplementation(async (id) => {
          stopped.push(id)
        })
        try {
          for (const id of ["trg_first", "trg_second"]) {
            const made = Trigger.create(
              { kind: "browser", spec: "browser_own", prompt: "check" },
              { projectID: "prj_selected", id, now: Date.now(), existing: 0 },
            )
            if (!made.ok) throw Error(made.error)
            yield* kv.set(Trigger.key("prj_selected", id), made.trigger as never)
          }
          expect((yield* run(tools, { action: "pause", id: "trg_first" })).status).toBe("completed")
          expect(stopped).toEqual([])
          expect((yield* run(tools, { action: "delete", id: "trg_second" })).status).toBe("completed")
          expect(stopped).toEqual(["browser_own"])
        } finally {
          registry.mockRestore()
          stop.mockRestore()
        }
      }).pipe(Effect.provide(harness(directory))),
    ),
  )
})
