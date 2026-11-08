// Child-process runner for test/node-build-guards.test.ts. Each case runs in
// its own short-lived process so the module mocks, the win32 platform
// override and the desktop env flags die with the child and can never leak
// into the suites that share the parent's process.
//   bun test ./test/fixture/node-build-guards-cases.ts -t <case>
// It is a bun-test file because mock.module only intercepts inside the test
// runner; each case is one test, selected by name from the parent.
import { mock, test } from "bun:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect, Exit } from "effect"
import { Location } from "@orchestra/core/location"
import { Memory } from "@orchestra/core/memory/index"
import { Permission } from "@orchestra/core/permission"
import { AbsolutePath } from "@orchestra/core/schema"
import { location as fixtureLocation } from "./location"

let bunAvailable = true
const hostCalls: string[] = []

mock.module("../../src/runtime.js", () => ({ bunRuntime: () => bunAvailable }))
mock.module("../../src/tool/plugin/desktop.js", () => ({
  isDesktopCaptureEnabled: () => true,
  makeHost: () => ({
    call: async (script: string) => {
      hostCalls.push(script)
      return "not a desktop result"
    },
    close: () => {},
  }),
}))

const forceWin32 = () => {
  // spyOn(process, "platform", "get") does not intercept Bun's data property.
  Object.defineProperty(process, "platform", { value: "win32", configurable: true })
}

type RegisteredTool = { execute: (input: never, context?: never) => Effect.Effect<unknown, unknown> }

/** Captures the tool definition a core tool plugin registers through its context. */
const fakeContext = () => {
  let tool: RegisteredTool | undefined
  const context = {
    tool: {
      transform: (edit: (editor: { add: (definition: RegisteredTool) => Effect.Effect<void> }) => Effect.Effect<void>) =>
        edit({
          add: (definition: RegisteredTool) => {
            tool = definition
            return Effect.void
          },
        }),
    },
  }
  return {
    context: context as never,
    tool: () => {
      if (tool === undefined) throw new Error("plugin did not register a tool")
      return tool
    },
  }
}

const locationInfo = (directory: string) =>
  Location.Service.of(fixtureLocation(Location.Ref.make({ directory: AbsolutePath.make(directory) })))

const toolContext = {
  sessionID: "ses_guards",
  agent: "build",
  messageID: "msg_guards",
  id: "toolu_guards",
} as never

const exists = async (target: string) =>
  import("node:fs/promises").then((fs) =>
    fs.access(target).then(
      () => true,
      () => false,
    ),
  )

/** Runs a case body with a temp project directory that is always removed. */
const withTempDir = async (prefix: string, body: (directory: string) => Promise<void>) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix))
  try {
    await body(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

const registerPlugin = async (
  specifier: string,
  provide: (effect: Effect.Effect<void, never, never>) => Effect.Effect<void, unknown, never> = (effect) => effect,
) => {
  const { Plugin } = (await import(specifier)) as {
    Plugin: { effect: unknown }
  }
  const { context, tool } = fakeContext()
  await Effect.runPromise(
    Effect.scoped(provide((Plugin.effect as (ctx: never) => Effect.Effect<void, never, never>)(context))),
  )
  return tool()
}

const memoryServices = (directory: string) => (effect: Effect.Effect<void, never, never>) =>
  effect.pipe(
    Effect.provideService(Memory.Service, {} as never),
    Effect.provideService(Permission.Service, { assert: () => Effect.void } as never),
    Effect.provideService(Location.Service, locationInfo(directory)),
  )

const failureText = (exit: Exit.Exit<unknown, unknown>): string => {
  assert.ok(Exit.isFailure(exit), "expected a failure exit")
  return String(exit.cause)
}

const cases: Record<string, () => Promise<void>> = {
  // A missing Bun runtime is a cached capability absence: one warning, and
  // the scrubbed file journal still keeps the record.
  "session-capability-warning": () =>
    withTempDir("orchestra-guard-capability-", async (directory) => {
      bunAvailable = false
      const { SessionMemory } = await import("@orchestra/core/memory/session")

      await mkdir(path.join(directory, ".orchestra", "memory.db"), { recursive: true })

      const first = SessionMemory.tryOpenSessionEngine(directory)
      assert.equal(first.engine, undefined)
      assert.equal(first.degradation?.kind, "capability")
      assert.equal(first.degradation?.warn, true)

      const second = SessionMemory.tryOpenSessionEngine(directory)
      assert.equal(second.degradation?.kind, "capability")
      assert.equal(second.degradation?.warn, false)

      const result = await Effect.runPromise(
        SessionMemory.captureToolUse({
          directory,
          sessionID: "ses_guard_capability" as never,
          toolUseID: "call_1",
          tool: "edit",
          inputText: "edit a.ts adding the config value",
          outputText: "edited a.ts successfully with the new config",
          scrub: (text: string) => text,
        }),
      )
      assert.equal(result.status, "recorded")
    }),

  // The memory tool refuses before any mkdir or write when Bun is absent,
  // naming the Bun-backed requirement.
  "memory-capability-refusal": () =>
    withTempDir("orchestra-guard-memory-", async (directory) => {
      bunAvailable = false
      const tool = await registerPlugin("@orchestra/core/tool/plugin/memory", memoryServices(directory))

      const exit = await Effect.runPromise(
        Effect.scoped(
          Effect.exit(
            tool.execute({ action: "remember", text: "remember the deployment window", entity: "project" } as never, toolContext),
          ),
        ),
      )
      const rendered = failureText(exit)
      assert.ok(rendered.includes("Bun-backed project memory database"), rendered)
      assert.ok(!rendered.includes("could not be opened"), rendered)
      assert.deepEqual(hostCalls, [])
      // The refusal precedes any filesystem side effect.
      assert.equal(await exists(path.join(directory, ".orchestra")), false)
    }),

  // An operational database failure under Bun reports the real cause, not a
  // missing capability.
  "memory-operational-cause": () =>
    withTempDir("orchestra-guard-operational-", async (directory) => {
      // This case runs under the real Bun runtime; the sibling cases set
      // bunAvailable = false, so the flag is reset explicitly here for
      // whole-file runs (the parent still isolates each case by process).
      bunAvailable = true
      // The database path exists as a DIRECTORY: the engine open fails
      // operationally under Bun, like a permissions/lock/damaged-database error.
      await mkdir(path.join(directory, ".orchestra", "memory.db"), { recursive: true })

      const tool = await registerPlugin("@orchestra/core/tool/plugin/memory", memoryServices(directory))

      const exit = await Effect.runPromise(
        Effect.scoped(Effect.exit(tool.execute({ action: "search", query: "deployment" } as never, toolContext))),
      )
      const rendered = failureText(exit)
      assert.ok(rendered.includes("could not be opened"), rendered)
      assert.ok(!rendered.includes("which this build does not have"), rendered)
    }),

  // Every codegraph action answers with the honest refusal before any fs
  // side effect.
  "codegraph-capability-refusal": () =>
    withTempDir("orchestra-guard-codegraph-", async (directory) => {
      bunAvailable = false
      const tool = await registerPlugin("@orchestra/core/tool/plugin/codegraph", (effect) =>
        effect.pipe(Effect.provideService(Location.Service, locationInfo(directory))),
      )

      for (const input of [
        { action: "search", name: "buildIndex" },
        { action: "explore", name: "buildIndex" },
        { action: "impact", name: "buildIndex" },
        { action: "status" },
        { action: "index" },
      ]) {
        const result = (await Effect.runPromise(
          Effect.scoped(tool.execute(input as never) as Effect.Effect<{ output: { output: string } }>),
        )) as { output: { output: string } }
        assert.ok(result.output.output.includes("unavailable in this build"), result.output.output)
        assert.ok(result.output.output.includes("Bun sqlite engine"), result.output.output)
      }

      assert.equal(await exists(path.join(directory, ".orchestra")), false)
    }),

  // win32 media keys refuse before the FFI call, naming Bun FFI.
  "desktop-media-ffi-refusal": async () => {
    bunAvailable = false
    forceWin32()
    const tool = await registerPlugin("@orchestra/core/tool/plugin/desktop-action")

    const exit = await Effect.runPromise(
      Effect.scoped(Effect.exit(tool.execute({ action: "media", command: "mute" } as never))),
    )
    assert.ok(failureText(exit).includes("Bun FFI"))
    assert.deepEqual(hostCalls, [])
  },

  // The real-screen permission denial stays first, ahead of the media guard.
  "desktop-real-screen-first": async () => {
    bunAvailable = false
    forceWin32()
    // Only capture is on; the real-screen grant envs stay unset (the parent
    // never exported them to this child).
    const tool = await registerPlugin("@orchestra/core/tool/plugin/desktop-action")

    const exit = await Effect.runPromise(
      Effect.scoped(Effect.exit(tool.execute({ action: "media", command: "mute" } as never))),
    )
    const rendered = failureText(exit)
    assert.ok(rendered.includes("Real-screen access is off"), rendered)
    assert.ok(!rendered.includes("Bun FFI"), rendered)
  },

  // Non-media actions keep their PowerShell dispatch: the mocked host proves
  // the dispatch was reached without a real shell; its unparseable reply
  // fails after the PowerShell call, never at the media guard or the
  // platform-unsupported branch.
  "desktop-nonmedia-dispatch": async () => {
    bunAvailable = false
    forceWin32()
    const tool = await registerPlugin("@orchestra/core/tool/plugin/desktop-action")

    const exit = await Effect.runPromise(Effect.scoped(Effect.exit(tool.execute({ action: "click" } as never))))
    assert.equal(hostCalls.length, 1)
    const rendered = failureText(exit)
    assert.ok(rendered.includes("desktop_action returned unreadable data"), rendered)
    assert.ok(!rendered.includes("Bun FFI"), rendered)
  },
}

for (const [name, body] of Object.entries(cases)) {
  test(name, body)
}
