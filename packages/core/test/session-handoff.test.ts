import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { SessionHandoff } from "@orchestra/core/session/handoff"

const run = <A>(effect: Effect.Effect<A, SessionHandoff.HandoffError>) => Effect.runPromise(effect)

const project = async () => mkdtemp(path.join(os.tmpdir(), "orchestra-handoff-"))

describe("session handoff", () => {
  test("renders the four sections and writes them to .orchestra/sessions/<id>/handoff.md", async () => {
    const directory = await project()
    await run(
      SessionHandoff.write(directory, "ses_abc", {
        reason: "user",
        stoppedAt: "2026-11-06T10:00:00.000Z",
        works: "Login works.",
        broken: "Export fails on empty lists.",
        nextStep: "Fix the export guard, then run the export tests.",
      }),
    )
    const text = await readFile(SessionHandoff.pathFor(directory, "ses_abc"), "utf8")
    expect(text).toContain("## What works")
    expect(text).toContain("Login works.")
    expect(text).toContain("## What does not work")
    expect(text).toContain("Export fails on empty lists.")
    expect(text).toContain("## Next step")
    expect(text).toContain("Fix the export guard")
    expect(text).not.toContain(SessionHandoff.STUB_MARKER)
  })

  test("a stub is created when nothing exists, refreshed when a stub exists, and never overwrites an agent handoff", async () => {
    const directory = await project()
    expect(await run(SessionHandoff.writeStubIfMissing(directory, "ses_abc", "inactivity"))).toBe("created")
    const stub = await readFile(SessionHandoff.pathFor(directory, "ses_abc"), "utf8")
    expect(stub.startsWith(SessionHandoff.STUB_MARKER)).toBe(true)
    expect(stub).toContain("(not recorded")
    expect(await run(SessionHandoff.writeStubIfMissing(directory, "ses_abc", "user"))).toBe("refreshed")

    await run(
      SessionHandoff.write(directory, "ses_abc", {
        reason: "user",
        works: "Everything works.",
        broken: "Nothing broken.",
        nextStep: "Ship it.",
      }),
    )
    expect(await run(SessionHandoff.writeStubIfMissing(directory, "ses_abc", "shutdown"))).toBe("kept")
    const kept = await readFile(SessionHandoff.pathFor(directory, "ses_abc"), "utf8")
    expect(kept).toContain("Ship it.")
  })

  test("an agent handoff racing a stub refresh is never clobbered by the stub", async () => {
    const directory = await project()
    for (let round = 0; round < 20; round++) {
      const id = `ses_race_${round}`
      await run(SessionHandoff.writeStubIfMissing(directory, id, "inactivity"))
      // The stub has already read a stub and is about to refresh it while
      // the agent writes the real handoff. Without the lock, the stub's
      // write can land after the agent's and the real handoff is lost.
      await Promise.all([
        run(
          SessionHandoff.write(directory, id, {
            reason: "user",
            works: "Everything works.",
            broken: "Nothing broken.",
            nextStep: `Ship it ${round}.`,
          }),
        ),
        run(SessionHandoff.writeStubIfMissing(directory, id, "shutdown")),
      ])
      const text = await readFile(SessionHandoff.pathFor(directory, id), "utf8")
      expect(text).toContain(`Ship it ${round}.`)
      expect(text).not.toContain(SessionHandoff.STUB_MARKER)
    }
  })
})
