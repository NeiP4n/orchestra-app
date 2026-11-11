import { expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import path from "node:path"
import os from "node:os"
import { ConsoleAccess as A } from "../src/console-access"
import { Pty } from "../src/pty"
import { PersistentPty } from "../src/persistent-pty"
import { Session } from "../src/session"
import { Location } from "../src/location"
import { ConsoleTool } from "../src/tool/plugin/console"
// Replace only services in this effect scope, never global modules used by other suites.
test("real Console tool guard wraps both PTY adapters before read/write and prevents cross-project access", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "console-tool-")),
    prior = process.env.ORCHESTRA_STATE_DIR
  process.env.ORCHESTRA_STATE_DIR = root
  let registered: any,
    reads = 0,
    writes: string[] = [],
    owner = "/tmp/project",
    project = "prj_fixture"
  const info = { id: "pty_fixture", cwd: "/tmp/project", sessionID: "ses_fixture" }
  const plain = {
    get: () => Effect.succeed(info),
    attach: () => {
      reads++
      return Effect.succeed({ replay: "real adapter fixture output", detach() {} })
    },
    write: (_id: string, text: string) => {
      writes.push(text)
      return Effect.void
    },
  }
  const persistent = {
    get: () => Effect.succeed(info),
    snapshot: () => {
      reads++
      return Effect.succeed({ text: "persistent adapter fixture output" })
    },
    write: plain.write,
  }
  const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.runPromise(
      effect.pipe(
        Effect.provideService(Pty.Service, plain as any),
        Effect.provideService(PersistentPty.Service, persistent as any),
        Effect.provideService(Session.Service, {
          get: (id: string) =>
            Effect.succeed({
              location: { directory: id === "ses_fixture" ? owner : "/other" },
              metadata: { "orchestra:project-owner": { projectID: project } },
            }),
        } as any),
        Effect.provideService(Location.Service, { directory: "/tmp/project" } as any),
      ) as Effect.Effect<A, E>,
    )
  const scope = {
    sessionID: "ses_fixture",
    directory: "/tmp/project",
    projectID: "prj_fixture",
    kind: "plain" as const,
    ptyID: "pty_fixture",
  }
  try {
    await run(
      ConsoleTool.Plugin.effect({
        tool: {
          transform: (fn: any) =>
            Effect.sync(() =>
              fn({
                add: (tool: any) => {
                  registered = tool
                },
              }),
            ),
        },
      } as any),
    )
    A.select(scope)
    const execute = (action: string, text?: string) =>
      run(
        registered.execute({ action, text }, { sessionID: "ses_fixture" }) as Effect.Effect<
          { content: string },
          unknown
        >,
      )
    await expect(execute("read")).rejects.toThrow()
    await expect(execute("write", "echo ok\n")).rejects.toThrow()
    expect(reads).toBe(0)
    expect(writes).toEqual([])
    A.set(scope, "read")
    expect((await execute("read")).content).toContain("Untrusted Console")
    expect(reads).toBe(1)
    A.set(scope, "confirm")
    await expect(execute("write", "echo ok\n")).rejects.toThrow()
    expect(writes).toEqual([])
    const pending = A.current(scope)
    A.approve(scope, pending.pending!, pending.revision)
    await execute("write", "echo ok\n")
    expect(writes).toEqual(["echo ok\n"])
    A.set(scope, "off")
    await expect(execute("write", "echo ok\n")).rejects.toThrow()
    expect(writes).toHaveLength(1)
    const next = { ...scope, kind: "persistent" as const }
    A.select(next)
    A.set(next, "full")
    expect((await execute("read")).content).toContain("persistent adapter")
    await execute("write", "\x03")
    expect(writes.at(-1)).toBe("\x03")
    project = "prj_foreign"
    await expect(execute("read")).rejects.toThrow()
    expect(reads).toBe(2)
    project = "prj_fixture"
    owner = "/tmp/other"
    await expect(execute("read")).rejects.toThrow()
    expect(reads).toBe(2)
  } finally {
    if (prior === undefined) delete process.env.ORCHESTRA_STATE_DIR
    else process.env.ORCHESTRA_STATE_DIR = prior
    rmSync(root, { recursive: true, force: true })
  }
})
