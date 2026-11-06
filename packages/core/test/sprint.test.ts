import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { Sprint } from "@orchestra/core/sprint"

const run = <A>(effect: Effect.Effect<A, Sprint.SprintError>) => Effect.runPromise(effect)

const project = async () => mkdtemp(path.join(os.tmpdir(), "orchestra-sprint-"))

describe("sprint cold start", () => {
  test("a fresh project has no phase; starting one opens a 30-minute read-only window", async () => {
    const directory = await project()
    expect(await run(Sprint.isReadOnly(directory))).toBe(false)
    expect(await run(Sprint.checkWrite(directory, "edit"))).toBeUndefined()

    const phase = await run(Sprint.start(directory, { startedBy: "orchestrator" }))
    expect(phase.minutes).toBe(Sprint.READ_ONLY_MINUTES)
    expect(phase.readOnlyUntil - phase.startedAt).toBe(30 * 60_000)
    expect(await run(Sprint.isReadOnly(directory, phase.startedAt + 1_000))).toBe(true)
    expect(await run(Sprint.isReadOnly(directory, phase.readOnlyUntil))).toBe(false)
    expect(await run(Sprint.remainingMs(directory, phase.startedAt))).toBe(30 * 60_000)

    const refusal = await run(Sprint.checkWrite(directory, "edit", phase.startedAt + 1_000))
    expect(refusal).toContain("read-only cold-start phase")
    expect(refusal).toContain("edit")
    // Read tools are never refused, and writes pass once the phase ends.
    expect(await run(Sprint.checkWrite(directory, "read", phase.startedAt + 1_000))).toBeUndefined()
    expect(await run(Sprint.checkWrite(directory, "edit", phase.readOnlyUntil))).toBeUndefined()
  })

  test("ending the phase early frees writes, and a corrupt phase file reads as no phase", async () => {
    const directory = await project()
    await run(Sprint.start(directory, { minutes: 30 }))
    expect(await run(Sprint.isReadOnly(directory))).toBe(true)
    await run(Sprint.end(directory))
    expect(await run(Sprint.isReadOnly(directory))).toBe(false)
    expect(await run(Sprint.checkWrite(directory, "write"))).toBeUndefined()
    await run(Sprint.end(directory))

    await writeFile(Sprint.pathFor(directory), "{not json", "utf8")
    expect(await run(Sprint.isReadOnly(directory))).toBe(false)
    expect(await run(Sprint.read(directory))).toBeUndefined()
  })
})
