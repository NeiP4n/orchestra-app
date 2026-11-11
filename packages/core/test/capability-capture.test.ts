import { expect } from "bun:test"
import { Tool } from "@orchestra/core/tool"
import { Session } from "@orchestra/core/session"
import { PluginHooks } from "@orchestra/core/plugin/hooks"
import { executeTool, toolIdentity, waitForTool } from "./lib/tool"
import { Effect, Layer, Schema } from "effect"
import { KV } from "@orchestra/core/kv"
import { Orchestra } from "@orchestra/core/orchestra"
import { Mcp } from "@orchestra/core/mcp/index"
import { CapabilityCapture as C } from "../src/capabilities/capture"
import { OutcomeLedger as L } from "../src/capabilities/outcome-ledger"
import { CapabilityOutcomesPlugin } from "../src/plugin/capability-outcomes"
import { host } from "./plugin/host"
import { PluginTestLayer } from "./plugin/fixture"
import { testEffect } from "./lib/effect"

let ownershipReads = 0,
  serverReads = 0
const orchestraLayer = Layer.mock(Orchestra.Service, {
  owners: () =>
    Effect.sync(() => {
      ownershipReads++
      return { ses_worker: Orchestra.ProjectID.make("prj_capture") }
    }),
  projects: () =>
    Effect.succeed([{ id: Orchestra.ProjectID.make("prj_capture"), main: "ses_main" } as Orchestra.Project]),
})
const mcpLayer = Layer.mock(Mcp.Service, {
  servers: () =>
    Effect.sync(() => {
      serverReads++
      return [
        { name: "serena", config: { type: "local" as const, command: [] }, status: { status: "connected" as const } },
      ]
    }),
})
const it = testEffect(Layer.mergeAll(PluginTestLayer, orchestraLayer, mcpLayer))
const scope = { projectID: "prj_capture", role: "coder", capability: "code" }
const call = { sessionID: "ses_worker", messageID: "msg_1", id: "call_1", tool: "grep", agent: "coder" }
it.effect("numeric capture is idempotent, isolated, bounded and never records transport success as acceptance", () =>
  Effect.gen(function* () {
    const kv = yield* KV.Service
    let now = 10000
    const capture = C.make(kv, () => now)
    yield* capture.begin(call, C.localAttribution("prj_capture", "grep"))
    yield* capture.begin(call, C.localAttribution("prj_capture", "grep"))
    now += 50
    yield* capture.end({ ...call, id: "other" })
    expect(capture.pendingCount()).toBe(1)
    yield* capture.end(call)
    yield* capture.end(call)
    const result = yield* L.make(kv).metrics(scope, now)
    expect(capture.pendingCount()).toBe(0)
    expect(result).toMatchObject({
      unverified: 1,
      metrics: [
        {
          toolID: "native:grep",
          attempts: 1,
          verifiedSuccesses: 0,
          totalLatencyMs: 50,
          totalOutputTokens: null,
          totalCostUsd: null,
        },
      ],
    })
    yield* capture.begin({ ...call, id: "abandoned" }, C.localAttribution("prj_capture", "grep"))
    now += 3600001
    yield* capture.begin({ ...call, id: "next" }, C.localAttribution("prj_capture", "grep"))
    expect(capture.pendingCount()).toBe(1)
  }),
)
it.effect("production hooks attribute owned native/Hub/MCP calls without storing raw input, output, or error", () =>
  Effect.gen(function* () {
    const kv = yield* KV.Service
    const hooks = new Map<string, (event: any) => Effect.Effect<void>>()
    const base = host()
    yield* CapabilityOutcomesPlugin.Plugin.effect(
      host({
        tool: {
          ...base.tool,
          list: () =>
            Effect.succeed([{ id: "grep" }, { id: "hub" }, { id: "find", options: { namespace: "serena" } }] as any),
          hook: (name: string, hook: any) =>
            Effect.sync(() => {
              hooks.set(name, hook)
              return { dispose: Effect.void }
            }),
        },
      }),
    )
    const before = hooks.get("execute.before")!,
      after = hooks.get("execute.after")!
    const first = { ...call, input: { pattern: "must-not-persist" } }
    yield* before(first)
    yield* after({ ...first, status: "completed", result: { output: "must-not-persist" } })
    yield* before({ ...first, id: "unowned", sessionID: "ses_unowned" })
    yield* after({ ...first, id: "unowned", sessionID: "ses_unowned", status: "completed" })
    yield* before({
      ...first,
      tool: "hub",
      id: "hub1",
      input: { id: "search.content", args: { pattern: "must-not-persist" } },
    })
    yield* after({ ...first, tool: "hub", id: "hub1", status: "error", error: "must-not-persist" })
    yield* before({ ...first, tool: "find", id: "mcp1" })
    yield* after({ ...first, tool: "find", id: "mcp1", status: "completed" })
    const evidence = yield* L.make(kv).metrics(scope, Date.now())
    expect(evidence.unverified).toBe(3)
    expect(evidence.metrics.map((row) => row.toolID).sort()).toEqual([
      "hub:search.content",
      "mcp:serena",
      "native:grep",
    ])
    expect(
      evidence.metrics.every(
        (row) => row.verifiedSuccesses === 0 && row.totalOutputTokens === null && row.totalCostUsd === null,
      ),
    ).toBe(true)
    const stored = yield* kv.scan({ prefix: "orchestra/capability-outcomes/v1/" })
    expect(JSON.stringify(stored)).not.toContain("must-not-persist")
    expect(ownershipReads).toBeGreaterThanOrEqual(4)
    expect(serverReads).toBe(1)
  }),
)

it.effect("real Tool.execute plus real hook dispatcher persists a numeric unverified observation", () =>
  Effect.gen(function* () {
    const registry = yield* Tool.Service
    const hooks = yield* PluginHooks.Service
    const ctx = host({
      tool: {
        transform: registry.transform,
        reload: registry.reload,
        list: registry.list,
        hook: (name, callback) => hooks.register("tool", name, callback),
      },
    })
    yield* CapabilityOutcomesPlugin.Plugin.effect(ctx)
    yield* registry.transform((editor) =>
      editor.add({
        name: "codegraph",
        description: "test numeric capture",
        input: Schema.Struct({}),
        options: { codemode: false, core: true },
        execute: () => Effect.succeed({ content: "must-not-persist" }),
      }),
    )
    yield* waitForTool(registry, "codegraph")
    const result = yield* executeTool(registry, {
      sessionID: Session.ID.make("ses_worker"),
      ...toolIdentity,
      call: { type: "tool-call", id: "capture-runtime", name: "codegraph", input: {} },
    })
    expect(result.status).toBe("completed")
    const kv = yield* KV.Service
    const evidence = yield* L.make(kv).metrics({ ...scope, role: String(toolIdentity.agent) }, Date.now())
    expect(evidence).toMatchObject({
      unverified: 1,
      metrics: [{ toolID: "native:codegraph", attempts: 1, verifiedSuccesses: 0, totalOutputTokens: null }],
    })
    expect(JSON.stringify(yield* kv.scan({ prefix: "orchestra/capability-outcomes/v1/" }))).not.toContain(
      "must-not-persist",
    )
  }),
)
