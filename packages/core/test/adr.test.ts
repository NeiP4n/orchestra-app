import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { Adr } from "@orchestra/core/adr"

const run = <A>(effect: Effect.Effect<A, Adr.AdrError>) => Effect.runPromise(effect)

const project = async () => mkdtemp(path.join(os.tmpdir(), "orchestra-adr-"))

describe("ADR store", () => {
  test("creates numbered records, lists them in order, and reads one back", async () => {
    const directory = await project()
    const first = await run(
      Adr.create(directory, {
        title: "Use Bun for scripts",
        context: "Scripts run in CI and locally.",
        decision: "Write scripts in TypeScript run with Bun.",
        alternatives: [{ option: "npm scripts", rejectedBecause: "slower startup and a second toolchain" }],
        consequences: "One runtime for app and scripts.",
      }),
    )
    expect(first.number).toBe(1)
    expect(first.status).toBe("accepted")
    const second = await run(
      Adr.create(directory, {
        title: "Store sessions in SQLite",
        context: "Sessions must survive restarts.",
        decision: "SQLite via Drizzle.",
        consequences: "One file to back up.",
      }),
    )
    expect(second.number).toBe(2)
    expect((await run(Adr.list(directory))).map((record) => record.number)).toEqual([1, 2])
    expect((await run(Adr.read(directory, 1)))?.title).toBe("Use Bun for scripts")
    expect(await run(Adr.read(directory, 99))).toBeUndefined()
    expect(await readFile(Adr.pathFor(directory, 1), "utf8")).toContain("# ADR-0001: Use Bun for scripts")
  })

  test("render and parse round-trip, including rejected alternatives", async () => {
    const directory = await project()
    const created = await run(
      Adr.create(directory, {
        title: "Pick a queue",
        context: "Workers need ordered work.",
        decision: "Use the inbox table.",
        alternatives: [
          { option: "Redis", rejectedBecause: "another service to run" },
          { option: "In-memory queue", rejectedBecause: "lost on restart" },
        ],
        consequences: "No new dependency.",
        status: "proposed",
      }),
    )
    const parsed = Adr.parse(await readFile(Adr.pathFor(directory, created.number), "utf8"))
    expect(parsed).toEqual(created)
  })

  test("searches title, context, decision and consequences, and skips stray files", async () => {
    const directory = await project()
    await run(
      Adr.create(directory, {
        title: "Use SQLite",
        context: "Durable storage.",
        decision: "SQLite.",
        consequences: "Backups are one file.",
      }),
    )
    await run(
      Adr.create(directory, {
        title: "Use Postgres",
        context: "Durable storage.",
        decision: "Postgres.",
        consequences: "Needs a server.",
      }),
    )
    // A markdown file that is not an ADR must not hide the real records.
    await writeFile(path.join(directory, ".orchestra", "decisions", "adr-9999.md"), "# Not an ADR\n", "utf8")
    expect((await run(Adr.search(directory, "postgres"))).map((record) => record.number)).toEqual([2])
    expect((await run(Adr.search(directory, "BACKUPS"))).map((record) => record.number)).toEqual([1])
    expect(await run(Adr.search(directory, "  "))).toEqual([])
    expect((await run(Adr.list(directory))).map((record) => record.number)).toEqual([1, 2])
  })

  test("an empty project lists nothing and refuses an empty record", async () => {
    const directory = await project()
    expect(await run(Adr.list(directory))).toEqual([])
    await expect(
      run(Adr.create(directory, { title: "", context: "", decision: "" })),
    ).rejects.toThrow("needs a title")
  })
})
