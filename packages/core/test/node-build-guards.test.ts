import { afterAll, afterEach, describe, expect, mock, test } from "bun:test"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect, Exit } from "effect"
import { Location } from "@orchestra/core/location"
import { Memory } from "@orchestra/core/memory/index"
import { Permission } from "@orchestra/core/permission"
import { AbsolutePath } from "@orchestra/core/schema"
import { location as fixtureLocation } from "./fixture/location"

// Direct refusal tests for the node-build capability guards (Node follow-ups
// 2-4 plus the session-engine acquisition classification). The no-Bun
// branches run through dependency seams — a module mock of the runtime
// predicate and of the PowerShell host — never through a mutation of the
// global Bun binding, and no real desktop key or shell action ever runs.

let bunAvailable = true
const hostCalls: string[] = []

// Module mocks are process-wide in bun test, so the real modules are
// captured first and restored in afterAll: later suites in the same process
// must see the unmocked runtime predicate and desktop host.
const realRuntime = await import("../src/runtime.js")
const realDesktop = await import("../src/tool/plugin/desktop.js")

mock.module("../src/runtime.js", () => ({ bunRuntime: () => bunAvailable }))
mock.module("../src/tool/plugin/desktop.js", () => ({
  isDesktopCaptureEnabled: () => true,
  makeHost: () => ({
    call: async (script: string) => {
      hostCalls.push(script)
      return "not a desktop result"
    },
    close: () => {},
  }),
}))

afterAll(() => {
  mock.module("../src/runtime.js", () => realRuntime)
  mock.module("../src/tool/plugin/desktop.js", () => realDesktop)
})

const restore = () => {
  bunAvailable = true
  hostCalls.length = 0
}
afterEach(restore)

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

describe("session engine acquisition without the Bun runtime", () => {
  test("a missing capability is cached with one warning and the journal keeps the record", async () => {
    bunAvailable = false
    const { SessionMemory } = await import("@orchestra/core/memory/session")

    const directory = await mkdtemp(path.join(os.tmpdir(), "orchestra-guard-capability-"))
    await mkdir(path.join(directory, ".orchestra", "memory.db"), { recursive: true })

    const first = SessionMemory.tryOpenSessionEngine(directory)
    expect(first.engine).toBeUndefined()
    expect(first.degradation?.kind).toBe("capability")
    expect(first.degradation?.warn).toBe(true)

    const second = SessionMemory.tryOpenSessionEngine(directory)
    expect(second.degradation?.kind).toBe("capability")
    expect(second.degradation?.warn).toBe(false)

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
    expect(result.status).toBe("recorded")

    await rm(directory, { recursive: true, force: true })
  })
})

describe("memory tool capability refusal", () => {
  test("without the Bun runtime it refuses before any mkdir or write and names the Bun build", async () => {
    bunAvailable = false
    const { Plugin } = await import("@orchestra/core/tool/plugin/memory")

    const directory = await mkdtemp(path.join(os.tmpdir(), "orchestra-guard-memory-"))
    const { context, tool } = fakeContext()
    await Effect.runPromise(
      Effect.scoped(
        (Plugin.effect as unknown as (ctx: never) => Effect.Effect<void, never, never>)(context).pipe(
          Effect.provideService(Memory.Service, {} as never),
          Effect.provideService(Permission.Service, { assert: () => Effect.void } as never),
          Effect.provideService(Location.Service, locationInfo(directory)),
        ),
      ),
    )

    const exit = await Effect.runPromise(
      Effect.scoped(
        Effect.exit(
          tool().execute({ action: "remember", text: "remember the deployment window", entity: "project" } as never, toolContext),
        ),
      ),
    )
    if (!Exit.isFailure(exit)) throw new Error("expected a failure exit")
    const rendered = String(exit.cause)
    expect(rendered).toContain("Bun-backed project memory database")
    expect(rendered).not.toContain("could not be opened")
    expect(hostCalls).toEqual([])
    // The refusal precedes any filesystem side effect.
    await expect(mkdtemp(path.join(directory, ".orchestra-"))).resolves.toBeTruthy()
    expect(
      await import("node:fs/promises").then((fs) =>
        fs.access(path.join(directory, ".orchestra")).then(
          () => true,
          () => false,
        ),
      ),
    ).toBe(false)

    await rm(directory, { recursive: true, force: true })
  })

  test("an operational database failure under Bun reports the real cause, not a missing capability", async () => {
    const { Plugin } = await import("@orchestra/core/tool/plugin/memory")

    const directory = await mkdtemp(path.join(os.tmpdir(), "orchestra-guard-operational-"))
    // The database path exists as a DIRECTORY: the engine open fails
    // operationally under Bun, like a permissions/lock/damaged-database error.
    await mkdir(path.join(directory, ".orchestra", "memory.db"), { recursive: true })

    const { context, tool } = fakeContext()
    await Effect.runPromise(
      Effect.scoped(
        (Plugin.effect as unknown as (ctx: never) => Effect.Effect<void, never, never>)(context).pipe(
          Effect.provideService(Memory.Service, {} as never),
          Effect.provideService(Permission.Service, { assert: () => Effect.void } as never),
          Effect.provideService(Location.Service, locationInfo(directory)),
        ),
      ),
    )

    const exit = await Effect.runPromise(
      Effect.scoped(Effect.exit(tool().execute({ action: "search", query: "deployment" } as never, toolContext))),
    )
    if (!Exit.isFailure(exit)) throw new Error("expected a failure exit")
    const rendered = String(exit.cause)
    expect(rendered).toContain("could not be opened")
    expect(rendered).not.toContain("which this build does not have")

    await rm(directory, { recursive: true, force: true })
  })
})

describe("codegraph capability refusal", () => {
  test("every action answers with the honest refusal before any fs side effect", async () => {
    bunAvailable = false
    const { Plugin } = await import("@orchestra/core/tool/plugin/codegraph")

    const directory = await mkdtemp(path.join(os.tmpdir(), "orchestra-guard-codegraph-"))
    const { context, tool } = fakeContext()
    await Effect.runPromise(
      Effect.scoped(
        (Plugin.effect as unknown as (ctx: never) => Effect.Effect<void, never, never>)(context).pipe(
          Effect.provideService(Location.Service, locationInfo(directory)),
        ),
      ),
    )

    for (const input of [
      { action: "search", name: "buildIndex" },
      { action: "explore", name: "buildIndex" },
      { action: "impact", name: "buildIndex" },
      { action: "status" },
      { action: "index" },
    ]) {
      const result = (await Effect.runPromise(
        Effect.scoped(tool().execute(input as never) as Effect.Effect<{ output: { output: string } }>),
      )) as { output: { output: string } }
      expect(result.output.output).toContain("unavailable in this build")
      expect(result.output.output).toContain("Bun sqlite engine")
    }

    expect(
      await import("node:fs/promises").then((fs) =>
        fs.access(path.join(directory, ".orchestra")).then(
          () => true,
          () => false,
        ),
      ),
    ).toBe(false)

    await rm(directory, { recursive: true, force: true })
  })
})

describe("desktop_action media keys without Bun FFI", () => {
  // spyOn(process, "platform", "get") does not intercept Bun's data
  // property, so the platform is overridden with a configurable descriptor.
  const realPlatform = Object.getOwnPropertyDescriptor(process, "platform")
  const forceWin32 = () => {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true })
  }

  // The desktop env flags are captured and restored, not deleted: a value
  // the environment already had before the suite must survive it.
  const DESKTOP_ENV = [
    "ORCHESTRA_DESKTOP_CAPTURE",
    "ORCHESTRA_DESKTOP_REAL_SCREEN",
    "ORCHESTRA_DESKTOP_REAL_SCREEN_ALLOWLIST",
    "ORCHESTRA_DESKTOP_REAL_SCREEN_UNTIL",
  ] as const
  const savedEnv = new Map(DESKTOP_ENV.map((name) => [name, process.env[name]]))
  afterAll(() => {
    for (const name of DESKTOP_ENV) {
      const before = savedEnv.get(name)
      if (before === undefined) delete process.env[name]
      else process.env[name] = before
    }
  })

  afterEach(() => {
    if (realPlatform) Object.defineProperty(process, "platform", realPlatform)
    delete process.env.ORCHESTRA_DESKTOP_CAPTURE
    delete process.env.ORCHESTRA_DESKTOP_REAL_SCREEN
    delete process.env.ORCHESTRA_DESKTOP_REAL_SCREEN_ALLOWLIST
    delete process.env.ORCHESTRA_DESKTOP_REAL_SCREEN_UNTIL
  })

  const allowRealScreen = () => {
    process.env.ORCHESTRA_DESKTOP_CAPTURE = "on"
    process.env.ORCHESTRA_DESKTOP_REAL_SCREEN = "on"
    process.env.ORCHESTRA_DESKTOP_REAL_SCREEN_ALLOWLIST = "calculator"
    process.env.ORCHESTRA_DESKTOP_REAL_SCREEN_UNTIL = "2999-01-01T00:00:00.000Z"
  }

  const register = async () => {
    const { Plugin } = await import("@orchestra/core/tool/plugin/desktop-action")
    const { context, tool } = fakeContext()
    await Effect.runPromise(Effect.scoped((Plugin.effect as unknown as (ctx: never) => Effect.Effect<void, never, never>)(context)))
    return tool()
  }

  test("win32 media keys refuse before the FFI call, naming Bun FFI", async () => {
    bunAvailable = false
    forceWin32()
    allowRealScreen()

    const tool = await register()
    const exit = await Effect.runPromise(
      Effect.scoped(Effect.exit(tool.execute({ action: "media", command: "mute" } as never))),
    )
    if (!Exit.isFailure(exit)) throw new Error("expected a failure exit")
    expect(String(exit.cause)).toContain("Bun FFI")
    expect(hostCalls).toEqual([])
  })

  test("the real-screen permission denial stays first, ahead of the media guard", async () => {
    bunAvailable = false
    forceWin32()
    process.env.ORCHESTRA_DESKTOP_CAPTURE = "on"

    const tool = await register()
    const exit = await Effect.runPromise(
      Effect.scoped(Effect.exit(tool.execute({ action: "media", command: "mute" } as never))),
    )
    if (!Exit.isFailure(exit)) throw new Error("expected a failure exit")
    const rendered = String(exit.cause)
    expect(rendered).toContain("Real-screen access is off")
    expect(rendered).not.toContain("Bun FFI")
  })

  test("non-media actions keep their PowerShell dispatch", async () => {
    bunAvailable = false
    forceWin32()
    allowRealScreen()

    const tool = await register()
    const exit = await Effect.runPromise(Effect.scoped(Effect.exit(tool.execute({ action: "click" } as never))))
    // The mocked host proves the dispatch was reached without a real shell;
    // its unparseable reply fails after the PowerShell call, never at the
    // media guard or the platform-unsupported branch.
    expect(hostCalls.length).toBe(1)
    if (!Exit.isFailure(exit)) throw new Error("expected a failure exit")
    const rendered = String(exit.cause)
    expect(rendered).toContain("desktop_action returned unreadable data")
    expect(rendered).not.toContain("Bun FFI")
  })
})
