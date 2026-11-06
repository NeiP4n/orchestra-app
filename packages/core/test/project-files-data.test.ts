import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rename, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@orchestra/core/database/database"
import { AutoloopStore } from "@orchestra/core/autoloop/kernel/store"
import type { AutoloopFact } from "@orchestra/core/autoloop/kernel/schema"
import { ProjectFiles } from "@orchestra/core/project-files/index"
import { ProjectFilesData } from "@orchestra/core/project-files/files-data"
import { Global } from "@orchestra/util/global"

// Syncers/restorers carry the Database.Service requirement, so effects
// that touch them run on a real in-memory database — never a mock.
const runDb = <A, E>(effect: Effect.Effect<A, E, Database.Service>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(Database.layer({ path: ":memory:" })),
      Effect.provideService(Global.Service, Global.make({ data: path.join(process.cwd(), ".test-data") })),
      Effect.scoped,
    ),
  )

// Effects that touch no database (kanban, dod-history, file reads) run
// without a layer; the cast is safe because no syncer runs in them.
const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.runPromise(effect as Effect.Effect<A, E, never>)

const fixture = async (): Promise<string> => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "orchestra-project-files-data-"))
  await mkdir(path.join(dir, ".orchestra"), { recursive: true })
  return dir
}

const write = async (dir: string, rel: string, contents: string): Promise<void> => {
  const file = path.join(dir, ".orchestra", rel)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, contents, "utf8")
}

const read = (dir: string, rel: string): Promise<string> =>
  readFile(path.join(dir, ".orchestra", rel), "utf8")

const DOD = `task_id: T-DATA
stages: []
leaves:
  - id: L-001
    what: "Free task"
    group: "Team A"
    task_state: NOT_STARTED
    steps:
      - "[ ] first step"
      - "[ ] second step"

  - id: L-002
    what: "Work in hand"
    group: "Team A"
    task_state: IN_PROGRESS
    owner: "Alex"
    owner_id: "g-alex"
    steps:
      - "[x] done step"
      - "[ ] open step"

  - id: L-003
    what: "Stuck task"
    group: "Team A"
    task_state: BLOCKED
    owner: "Bo"
    owner_id: "g-bo"

  - id: L-004
    what: "Failed check"
    group: "Team B"
    task_state: FAILED

  - id: L-005
    what: "Finished task"
    group: "Team B"
    task_state: DONE

  - id: L-006
    what: "Dropped task"
    group: "Team B"
    task_state: OUT_OF_SCOPE
`

const ZONES = `zones:
  - name: "Team A"
    owner_group: "team-a"
  - name: "Team B"
    owner_group: "team-b"
passes: []
`

describe("ProjectFiles data descriptors", () => {
  test("every data file is registered, derived or db-backed, and none is versioned", () => {
    const rels = ["kanban.yaml", "dod-history/", "errors.jsonl", "events.jsonl", "usage.jsonl", "quarantine.jsonl"]
    for (const rel of rels) {
      const descriptor = ProjectFiles.ProjectFilesRegistry.descriptorFor(rel)
      expect(descriptor).toBeDefined()
      expect(descriptor?.git).toBe(false)
    }
    expect(ProjectFiles.ProjectFilesRegistry.descriptorFor("kanban.yaml")?.source).toBe("derived")
    expect(ProjectFiles.ProjectFilesRegistry.descriptorFor("quarantine.jsonl")?.source).toBe("db")
    expect(ProjectFiles.ProjectFilesRegistry.descriptorFor("events.jsonl")?.source).toBe("db")
    for (const rel of rels) {
      expect(ProjectFiles.ProjectFilesRegistry.gitTrackedRels()).not.toContain(rel)
    }
  })
})

describe("ProjectFiles kanban", () => {
  test("sync writes kanban.yaml matching the live board", async () => {
    const dir = await fixture()
    await write(dir, "dod.yaml", DOD)
    await write(dir, "zones.yaml", ZONES)
    const result = await runDb(
      ProjectFiles.ProjectFilesSync.syncFile(dir, "kanban.yaml", { kv: undefined as never }),
    )
    expect(result.status).toBe("ok")
    const board = await run(ProjectFilesData.readKanban(dir))
    expect(board.status).toBe("ready")
    // L-002 and L-003 have holders but no lease, and the sync has no
    // liveness source — so they read stale and count as free, the same
    // rule `Dod` documents for a bare directory.
    expect(board.counts).toEqual({ total: 6, done: 2, inProgress: 1, blocked: 1, failed: 1, free: 4 })
    const byColumn = new Map(board.columns.map((column) => [column.id, column.cards.map((card) => card.id)]))
    expect(byColumn.get("todo")).toEqual(["L-001"])
    expect(byColumn.get("in_progress")).toEqual(["L-002"])
    expect(byColumn.get("blocked")).toEqual(["L-003"])
    expect(byColumn.get("failed")).toEqual(["L-004"])
    expect(byColumn.get("done")).toEqual(["L-005", "L-006"])
    expect(await read(dir, "kanban.yaml")).toContain("L-001")
  })

  test("a stale kanban.yaml is a divergence visible in health.json", async () => {
    const dir = await fixture()
    await write(dir, "dod.yaml", DOD)
    await write(dir, "zones.yaml", ZONES)
    await runDb(ProjectFiles.ProjectFilesSync.syncFile(dir, "kanban.yaml", { kv: undefined as never }))
    expect(await run(ProjectFilesData.compareKanban(dir))).toEqual([])
    await write(dir, "dod.yaml", DOD.replace('task_state: DONE\n', 'task_state: IN_PROGRESS\n'))
    const divergences = await run(ProjectFilesData.compareKanban(dir))
    expect(divergences).toHaveLength(1)
    expect(divergences[0]?.path).toBe("kanban.yaml")
    expect(divergences[0]?.detail).toContain("L-005")
    const report = await run(ProjectFiles.ProjectFilesHealth.checkHealth(dir, divergences))
    const kanban = report.files.find((file) => file.path === "kanban.yaml")
    expect(kanban?.status).toBe("divergent")
    expect(kanban?.detail).toContain("L-005")
    expect(report.status).toBe("degraded")
  })

  test("a corrupt kanban.yaml fails loudly on read and on compare", async () => {
    const dir = await fixture()
    await write(dir, "kanban.yaml", "columns: [broken\n")
    await expect(run(ProjectFilesData.readKanban(dir))).rejects.toMatchObject({
      _tag: "ProjectFiles.Error",
      kind: "corrupt",
    })
    await expect(run(ProjectFilesData.compareKanban(dir))).rejects.toMatchObject({
      _tag: "ProjectFiles.Error",
      kind: "corrupt",
    })
  })

  test("without a DoD the board syncs as disabled, not as an empty ready board", async () => {
    const dir = await fixture()
    const result = await runDb(
      ProjectFiles.ProjectFilesSync.syncFile(dir, "kanban.yaml", { kv: undefined as never }),
    )
    expect(result.status).toBe("ok")
    const board = await run(ProjectFilesData.readKanban(dir))
    expect(board.status).toBe("disabled")
    expect(board.counts.total).toBe(0)
  })

  test("a corrupt dod.yaml fails the kanban sync instead of writing a board", async () => {
    const dir = await fixture()
    await write(dir, "dod.yaml", "task_id: [broken\n")
    const result = await runDb(
      ProjectFiles.ProjectFilesSync.syncFile(dir, "kanban.yaml", { kv: undefined as never }),
    )
    expect(result.status).toBe("failed")
    expect(result.error).toContain("dod.yaml")
  })
})

describe("ProjectFiles dod-history", () => {
  test("snapshots on change only, with the dod.yaml contents", async () => {
    const dir = await fixture()
    await write(dir, "dod.yaml", DOD)
    const first = await run(ProjectFilesData.snapshotDodIfChanged(dir))
    expect(first.changed).toBe(true)
    expect(first.name).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-\d{4}-[0-9a-f]{8}\.yaml$/)
    expect(await run(ProjectFilesData.listDodHistory(dir))).toHaveLength(1)
    expect(await read(dir, `dod-history/${first.name}`)).toBe(DOD)
    const again = await run(ProjectFilesData.snapshotDodIfChanged(dir))
    expect(again).toEqual({ changed: false, name: null })
    expect(await run(ProjectFilesData.listDodHistory(dir))).toHaveLength(1)
    await write(dir, "dod.yaml", DOD.replace("Free task", "Free task, renamed"))
    const second = await run(ProjectFilesData.snapshotDodIfChanged(dir))
    expect(second.changed).toBe(true)
    expect(await run(ProjectFilesData.listDodHistory(dir))).toHaveLength(2)
  })

  test("prunes older snapshots past the cap of 30", async () => {
    const dir = await fixture()
    for (let i = 0; i < 32; i++) {
      await write(dir, "dod.yaml", `${DOD}\n# change ${i}\n`)
      await run(ProjectFilesData.snapshotDod(dir))
    }
    const names = await run(ProjectFilesData.listDodHistory(dir))
    expect(names).toHaveLength(ProjectFilesData.DOD_HISTORY_KEEP)
    const kept = await read(dir, `dod-history/${names.at(-1)!}`)
    expect(kept).toContain("# change 31")
  })

  test("a missing dod.yaml fails the snapshot loudly", async () => {
    const dir = await fixture()
    await expect(run(ProjectFilesData.snapshotDod(dir))).rejects.toMatchObject({
      _tag: "ProjectFiles.Error",
      kind: "missing",
    })
  })
})

const queued = (id: string, key: string, time: number): AutoloopFact => ({
  id,
  type: "run.queued",
  collection: "runs",
  key,
  data: { state: "queued" },
  time,
})

const doneWithUsage = (id: string, key: string, time: number): AutoloopFact => ({
  id,
  type: "run.done",
  collection: "runs",
  key,
  data: { state: "done", usage: { input: 100, output: 50 }, session: "s-1" },
  time,
})

describe("ProjectFiles journal mirrors", () => {
  test("sync mirrors every fact to events, failed facts to errors, receipts to usage", async () => {
    const dir = await fixture()
    await write(dir, "dod.yaml", DOD)
    await write(dir, "zones.yaml", ZONES)
    const report = await runDb(
      Effect.gen(function* () {
        yield* AutoloopStore.commitLatest([
          queued("f1", "run_1", 1000),
          doneWithUsage("f2", "run_1", 2000),
          {
            id: "f3",
            type: "run.failed",
            collection: "runs",
            key: "run_1",
            data: { state: "failed", summary: "check exploded" },
            time: 3000,
          },
          {
            id: "f4",
            type: "event.recorded",
            collection: "events",
            key: "e1",
            data: { outcome: "failed", summary: "downstream failed" },
            time: 4000,
          },
        ])
        return yield* ProjectFiles.ProjectFilesSync.syncAll(dir, { kv: undefined as never })
      }),
    )
    // This test owns the journal mirrors, not the whole report: the state
    // syncers need a real KV, which this test does not provide, so only
    // the three journal files are asserted ok here.
    const byFile = new Map(report.files.map((file) => [file.file, file.status]))
    for (const file of ["events.jsonl", "errors.jsonl", "usage.jsonl"]) {
      expect(byFile.get(file)).toBe("ok")
    }
    const events = await run(ProjectFilesData.readEvents(dir))
    expect(events.map((entry) => entry.seq)).toEqual([1, 2, 3, 4])
    expect(events.map((entry) => entry.kind)).toEqual(["run.queued", "run.done", "run.failed", "event.recorded"])
    expect(events[1]).toMatchObject({ seq: 2, at: 2000, kind: "run.done", id: "f2" })
    const errors = await run(ProjectFilesData.readErrors(dir))
    expect(errors.map((entry) => entry.seq)).toEqual([3, 4])
    expect(errors[0]).toMatchObject({ seq: 3, kind: "run.failed", message: "check exploded" })
    expect(errors[1]).toMatchObject({ seq: 4, kind: "event.recorded", message: "downstream failed" })
    const usage = await run(ProjectFilesData.readUsage(dir))
    expect(usage).toEqual([
      { seq: 2, at: 2000, run: "run_1", session: "s-1", tokens: { input: 100, output: 50 } },
    ])
  })

  test("a second sync appends only new rows — the watermark, never a rewrite", async () => {
    const dir = await fixture()
    await runDb(
      Effect.gen(function* () {
        yield* AutoloopStore.commitLatest([queued("f1", "run_1", 1000), doneWithUsage("f2", "run_1", 2000)])
        yield* ProjectFiles.ProjectFilesSync.syncAll(dir, { kv: undefined as never })
        yield* AutoloopStore.commitLatest([queued("f3", "run_2", 3000)])
        yield* ProjectFiles.ProjectFilesSync.syncAll(dir, { kv: undefined as never })
      }),
    )
    const events = await run(ProjectFilesData.readEvents(dir))
    expect(events.map((entry) => entry.seq)).toEqual([1, 2, 3])
    const usage = await run(ProjectFilesData.readUsage(dir))
    expect(usage).toHaveLength(1)
  })

  test("the watermark survives rotation: rows in the .1 copy are not re-appended", async () => {
    const dir = await fixture()
    await runDb(
      Effect.gen(function* () {
        yield* AutoloopStore.commitLatest([
          queued("f1", "run_1", 1000),
          {
            id: "f2",
            type: "run.failed",
            collection: "runs",
            key: "run_1",
            data: { state: "failed", summary: "boom" },
            time: 2000,
          },
        ])
        yield* ProjectFiles.ProjectFilesSync.syncAll(dir, { kv: undefined as never })
        expect((yield* ProjectFilesData.readErrors(dir)).map((entry) => entry.seq)).toEqual([2])
        // Simulate the 1 MiB rotation: the live file moves to errors.jsonl.1.
        // (One database throughout: a fresh :memory: DB would restart seq at 1.)
        yield* Effect.tryPromise({
          try: () =>
            rename(path.join(dir, ".orchestra", "errors.jsonl"), path.join(dir, ".orchestra", "errors.jsonl.1")),
          catch: (error) => error as Error,
        })
        yield* AutoloopStore.commitLatest([
          {
            id: "f3",
            type: "run.failed",
            collection: "runs",
            key: "run_1",
            data: { state: "failed", summary: "boom again" },
            time: 3000,
          },
        ])
        yield* ProjectFiles.ProjectFilesSync.syncAll(dir, { kv: undefined as never })
        const errors = yield* ProjectFilesData.readErrors(dir)
        expect(errors.map((entry) => entry.seq)).toEqual([3])
        expect(errors[0]?.message).toBe("boom again")
      }),
    )
  })

  test("a corrupt log line fails the sync loudly instead of guessing a watermark", async () => {
    const dir = await fixture()
    await write(dir, "errors.jsonl", '{"seq": 1, "at": 1, "kind": "run.failed", "message": "ok"}\nnot json\n')
    const result = await runDb(
      ProjectFiles.ProjectFilesSync.syncFile(dir, "errors.jsonl", { kv: undefined as never }),
    )
    expect(result.status).toBe("failed")
    await expect(run(ProjectFilesData.readErrors(dir))).rejects.toMatchObject({
      _tag: "ProjectFiles.Error",
      kind: "corrupt",
    })
  })

  test("a missing log file reads as an empty log, not an error", async () => {
    const dir = await fixture()
    expect(await run(ProjectFilesData.readEvents(dir))).toEqual([])
    expect(await run(ProjectFilesData.readErrors(dir))).toEqual([])
    expect(await run(ProjectFilesData.readUsage(dir))).toEqual([])
    expect(await run(ProjectFilesData.readQuarantine(dir))).toEqual([])
  })
})

describe("ProjectFiles quarantine", () => {
  test("sync writes the mirror; wiping the table and restoring from files re-quarantines the fact", async () => {
    const dir = await fixture()
    const report = await runDb(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* AutoloopStore.commitLatest([queued("f1", "run_1", 1000), doneWithUsage("f2", "run_1", 2000)])
        const quarantined = yield* AutoloopStore.quarantine(2, "poisoned: run never finished")
        expect(quarantined.changed).toBe(true)
        const synced = yield* ProjectFiles.ProjectFilesSync.syncFile(dir, "quarantine.jsonl", {
          kv: undefined as never,
        })
        expect(synced.status).toBe("ok")
        const mirrored = yield* ProjectFilesData.readQuarantine(dir)
        expect(mirrored).toHaveLength(1)
        expect(mirrored[0]?.seq).toBe(2)
        expect(mirrored[0]?.reason).toBe("poisoned: run never finished")
        // The database is gone for the quarantine table — only the file is left.
        yield* db.run(sql`DELETE FROM autoloop_quarantine`)
        expect(yield* AutoloopStore.listQuarantine()).toEqual([])
        const restored = yield* ProjectFiles.ProjectFilesRestore.restoreFromFiles(dir, {
          kv: undefined as never,
        })
        const entry = restored.entries.find((item) => item.file === "quarantine.jsonl")
        expect(entry?.status).toBe("restored")
        expect(entry?.count).toBe(1)
        // The poisoned fact is quarantined again — and the next rebuild
        // does not replay it: the run falls back to "queued" (fact 1 only).
        expect(yield* AutoloopStore.listQuarantine()).toHaveLength(1)
        const opened = yield* AutoloopStore.openView()
        expect(opened.view).toEqual({ runs: { run_1: { state: "queued" } } })
        const rebuilt = yield* AutoloopStore.rebuildProjections()
        expect(rebuilt.view).toEqual(opened.view)
        return restored
      }),
    )
    expect(report.entries.find((item) => item.file === "quarantine.jsonl")?.status).toBe("restored")
  })

  test("unquarantining removes the line on the next sync", async () => {
    const dir = await fixture()
    await runDb(
      Effect.gen(function* () {
        yield* AutoloopStore.commitLatest([queued("f1", "run_1", 1000), doneWithUsage("f2", "run_1", 2000)])
        yield* AutoloopStore.quarantine(2, "poisoned")
        yield* ProjectFiles.ProjectFilesSync.syncFile(dir, "quarantine.jsonl", { kv: undefined as never })
        expect(yield* ProjectFilesData.readQuarantine(dir)).toHaveLength(1)
        yield* AutoloopStore.unquarantine(2)
        yield* ProjectFiles.ProjectFilesSync.syncFile(dir, "quarantine.jsonl", { kv: undefined as never })
        expect(yield* ProjectFilesData.readQuarantine(dir)).toEqual([])
      }),
    )
  })

  test("a missing quarantine file restores as skipped", async () => {
    const dir = await fixture()
    const report = await runDb(
      ProjectFiles.ProjectFilesRestore.restoreFromFiles(dir, { kv: undefined as never }),
    )
    expect(report.entries.find((item) => item.file === "quarantine.jsonl")).toEqual({
      file: "quarantine.jsonl",
      status: "skipped",
    })
  })

  test("a corrupt quarantine file fails the restore and leaves the table empty", async () => {
    const dir = await fixture()
    await write(dir, "quarantine.jsonl", '{"seq": 2, "reason": "poisoned", "at": 1}\nbroken\n')
    const report = await runDb(
      Effect.gen(function* () {
        const restored = yield* ProjectFiles.ProjectFilesRestore.restoreFromFiles(dir, {
          kv: undefined as never,
        })
        expect(yield* AutoloopStore.listQuarantine()).toEqual([])
        return restored
      }),
    )
    const quarantine = report.entries.find((item) => item.file === "quarantine.jsonl")
    expect(quarantine?.status).toBe("failed")
    expect(quarantine?.error).toContain("quarantine.jsonl")
  })

  test("restoring a fact the journal no longer has fails loudly", async () => {
    const dir = await fixture()
    await write(dir, "quarantine.jsonl", '{"seq": 99, "reason": "poisoned", "at": 1}\n')
    const report = await runDb(
      ProjectFiles.ProjectFilesRestore.restoreFromFiles(dir, { kv: undefined as never }),
    )
    const quarantine = report.entries.find((item) => item.file === "quarantine.jsonl")
    expect(quarantine?.status).toBe("failed")
    expect(quarantine?.error).toContain("99")
  })
})
