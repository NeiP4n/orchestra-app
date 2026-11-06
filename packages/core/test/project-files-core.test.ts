import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { AppNodeBuilder } from "@orchestra/core/effect/app-node-builder"
import { LayerNode } from "@orchestra/util/effect/layer-node"
import { Global } from "@orchestra/util/global"
import { Database } from "@orchestra/core/database/database"
import { KV } from "@orchestra/core/kv"
import { ProjectFiles } from "@orchestra/core/project-files/index"
import { tempGlobalLayer } from "./fixture/global"
import { testEffect } from "./lib/effect"

// The framework functions carry the Database.Service requirement for the
// syncers/restorers they call; the slices register real ones, so these
// tests run them against a real temp database + KV instead of casting the
// service away. Pure-format tests below still use the cast, which is
// safe there because they never touch a syncer or restorer.
const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, KV.node]), [Global.node.replace(tempGlobalLayer)]),
)

// Pure-format tests below never touch a syncer or restorer, so the
// Database.Service requirement is never used and the cast is safe there.
const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.runPromise(effect as Effect.Effect<A, E, never>)

const fixture = async (): Promise<string> => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "orchestra-project-files-"))
  await mkdir(path.join(dir, ".orchestra"), { recursive: true })
  return dir
}

const write = async (dir: string, rel: string, contents: string): Promise<void> => {
  const file = path.join(dir, ".orchestra", rel)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, contents, "utf8")
}

describe("ProjectFiles index", () => {
  test("generates an index listing files, excluding itself, snapshots as one entry", async () => {
    const dir = await fixture()
    await write(dir, "dod.yaml", "task_id: X\nleaves: []\n")
    await write(dir, "notes/plan.md", "# plan\n")
    await write(dir, "mystery.txt", "nobody registered me\n")
    await mkdir(path.join(dir, ".orchestra", "snapshots", "s1"), { recursive: true })
    await writeFile(path.join(dir, ".orchestra", "snapshots", "s1", "snapshot.json"), "{}\n", "utf8")
    const index = await run(ProjectFiles.ProjectFilesIndex.refreshIndex(dir))
    const paths = index.entries.map((entry) => entry.path)
    expect(paths).toContain("dod.yaml")
    expect(paths).toContain("notes/plan.md")
    expect(paths).toContain("mystery.txt")
    expect(paths).not.toContain("index.yaml")
    expect(paths).not.toContain("snapshots/s1/snapshot.json")
    const snapshots = index.entries.find((entry) => entry.path === "snapshots/")
    expect(snapshots?.count).toBe(1)
    const mystery = index.entries.find((entry) => entry.path === "mystery.txt")
    expect(mystery?.kind).toBe("unknown")
    const dod = index.entries.find((entry) => entry.path === "dod.yaml")
    expect(dod?.sha256).toMatch(/^[0-9a-f]{64}$/)
    const readBack = await run(ProjectFiles.ProjectFilesIndex.readIndex(dir))
    expect(readBack.entries.length).toBe(index.entries.length)
  })

  test("a missing index reads as empty, a corrupt index fails loudly", async () => {
    const dir = await fixture()
    const empty = await run(ProjectFiles.ProjectFilesIndex.readIndex(dir))
    expect(empty.entries).toEqual([])
    await write(dir, "index.yaml", "not: [valid: yaml\n")
    await expect(run(ProjectFiles.ProjectFilesIndex.readIndex(dir))).rejects.toMatchObject({
      _tag: "ProjectFiles.Error",
      kind: "corrupt",
    })
  })
})

describe("ProjectFiles health", () => {
  test("healthy when every registered file exists and parses", async () => {
    const dir = await fixture()
    for (const descriptor of ProjectFiles.ProjectFilesRegistry.allDescriptors()) {
      if (descriptor.dir) {
        await mkdir(path.join(dir, ".orchestra", descriptor.rel), { recursive: true })
      } else if (descriptor.rel.endsWith(".yaml") || descriptor.rel.endsWith(".yml")) {
        await write(dir, descriptor.rel, "key: value\n")
      } else if (descriptor.rel.endsWith(".json")) {
        await write(dir, descriptor.rel, "{}\n")
      } else if (descriptor.rel.endsWith(".jsonl")) {
        await write(dir, descriptor.rel, "{}\n")
      } else {
        await write(dir, descriptor.rel, "text\n")
      }
    }
    await run(ProjectFiles.ProjectFilesIndex.refreshIndex(dir))
    const report = await run(ProjectFiles.ProjectFilesHealth.checkHealth(dir))
    expect(report.status).toBe("healthy")
    expect(report.files.every((file) => file.status === "ok")).toBe(true)
  })

  test("a corrupt file makes the report unhealthy and names the file", async () => {
    const dir = await fixture()
    await write(dir, "dod.yaml", "task_id: [broken\n")
    await run(ProjectFiles.ProjectFilesIndex.refreshIndex(dir))
    const report = await run(ProjectFiles.ProjectFilesHealth.checkHealth(dir))
    expect(report.status).toBe("unhealthy")
    const dod = report.files.find((file) => file.path === "dod.yaml")
    expect(dod?.status).toBe("corrupt")
  })

  test("a missing file makes the report degraded, not silent", async () => {
    const dir = await fixture()
    await run(ProjectFiles.ProjectFilesIndex.refreshIndex(dir))
    const report = await run(ProjectFiles.ProjectFilesHealth.checkHealth(dir))
    expect(report.status).toBe("degraded")
    expect(report.files.some((file) => file.status === "missing")).toBe(true)
  })

  test("a divergence passed by a slice is visible in health.json", async () => {
    const dir = await fixture()
    await write(dir, "rules.yaml", "rules: []\n")
    const report = await run(
      ProjectFiles.ProjectFilesHealth.checkHealth(dir, [
        { path: "rules.yaml", detail: "file has 0 rules, database has 3" },
      ]),
    )
    const rules = report.files.find((file) => file.path === "rules.yaml")
    expect(rules?.status).toBe("divergent")
    expect(rules?.detail).toBe("file has 0 rules, database has 3")
    const stored = JSON.parse(await readFile(path.join(dir, ".orchestra", "health.json"), "utf8"))
    expect(stored.status).toBe(report.status)
  })
})

describe("ProjectFiles snapshots", () => {
  test("create, restore and prune", async () => {
    const dir = await fixture()
    await write(dir, "dod.yaml", "task_id: X\nleaves: []\n")
    await write(dir, "briefing.md", "# briefing\n")
    const created = await run(ProjectFiles.ProjectFilesSnapshot.createSnapshot(dir, { label: "before" }))
    expect(created.files).toContain("dod.yaml")
    expect(created.files).toContain("briefing.md")
    await write(dir, "dod.yaml", "task_id: Y\nleaves: []\n")
    const name = (await readdir(path.join(dir, ".orchestra", "snapshots")))[0]
    const restored = await run(ProjectFiles.ProjectFilesSnapshot.restoreSnapshot(dir, name))
    expect(restored.restored).toContain("dod.yaml")
    expect(await readFile(path.join(dir, ".orchestra", "dod.yaml"), "utf8")).toContain("task_id: X")
    for (let i = 0; i < 9; i++) {
      await run(ProjectFiles.ProjectFilesSnapshot.createSnapshot(dir, { label: `s${i}` }))
    }
    const kept = await run(ProjectFiles.ProjectFilesSnapshot.listSnapshots(dir))
    expect(kept.length).toBe(ProjectFiles.ProjectFilesSnapshot.SNAPSHOT_KEEP)
  })

  test("restoring a corrupt snapshot fails and leaves current files intact", async () => {
    const dir = await fixture()
    await write(dir, "dod.yaml", "task_id: X\nleaves: []\n")
    await run(ProjectFiles.ProjectFilesSnapshot.createSnapshot(dir, { label: "good" }))
    const name = (await readdir(path.join(dir, ".orchestra", "snapshots")))[0]
    await writeFile(path.join(dir, ".orchestra", "snapshots", name, "dod.yaml"), "task_id: [broken\n", "utf8")
    await expect(run(ProjectFiles.ProjectFilesSnapshot.restoreSnapshot(dir, name))).rejects.toMatchObject({
      _tag: "ProjectFiles.Error",
      kind: "restore-failed",
    })
    expect(await readFile(path.join(dir, ".orchestra", "dod.yaml"), "utf8")).toContain("task_id: X")
  })
})

describe("ProjectFiles sync and restore frameworks", () => {
  // All three slices register real syncers, so syncAll runs them against
  // a real temp database + KV: the state syncers mirror empty KV stores
  // and the DoD/ADR projections, the data syncers mirror the empty
  // journal, the integration syncers validate the (absent) mcp.yaml —
  // all ok — then the index and health refresh.
  it.live("syncAll runs the registered syncers and writes index and health", () =>
    Effect.gen(function* () {
      const dir = yield* Effect.tryPromise(() => fixture())
      yield* Effect.tryPromise(() => write(dir, "dod.yaml", "task_id: X\nleaves: []\n"))
      const kv = yield* KV.Service
      const report = yield* ProjectFiles.ProjectFilesSync.syncAll(dir, { kv })
      expect(report.files.every((file) => file.status === "ok")).toBe(true)
      expect(report.files.map((file) => file.file)).toContain("rules.yaml")
      expect(report.files.map((file) => file.file)).toContain("tasks.yaml")
      expect(report.files.map((file) => file.file)).toContain("kanban.yaml")
      expect(report.files.map((file) => file.file)).toContain("INTEGRATE.md")
      expect(yield* Effect.tryPromise(() => readFile(path.join(dir, ".orchestra", "index.yaml"), "utf8"))).toContain(
        "dod.yaml",
      )
      expect(yield* Effect.tryPromise(() => readFile(path.join(dir, ".orchestra", "health.json"), "utf8"))).toContain(
        "checkedAt",
      )
    }),
  )

  // All three slices register real restorers; with no mirror files
  // present each one skips — except INTEGRATE.md, which the S3 restorer
  // regenerates — and the index and health still refresh.
  it.live("restoreFromFiles skips absent mirrors and refreshes index and health", () =>
    Effect.gen(function* () {
      const dir = yield* Effect.tryPromise(() => fixture())
      yield* Effect.tryPromise(() => write(dir, "dod.yaml", "task_id: X\nleaves: []\n"))
      const kv = yield* KV.Service
      const report = yield* ProjectFiles.ProjectFilesRestore.restoreFromFiles(dir, { kv })
      expect(report.entries.every((entry) => entry.status !== "failed")).toBe(true)
      expect(report.entries.map((entry) => entry.file)).toContain("rules.yaml")
      expect(report.entries.map((entry) => entry.file)).toContain("quarantine.jsonl")
      expect(report.entries.map((entry) => entry.file)).toContain("INTEGRATE.md")
      expect(yield* Effect.tryPromise(() => readFile(path.join(dir, ".orchestra", "index.yaml"), "utf8"))).toContain(
        "dod.yaml",
      )
    }),
  )

  test("every git-tracked file has a negation in the repo root .gitignore", async () => {
    const gitignore = await readFile(path.join(import.meta.dir, "..", "..", "..", ".gitignore"), "utf8")
    for (const line of ProjectFiles.ProjectFilesRegistry.gitignoreLines()) {
      expect(gitignore).toContain(`${line}\n`)
    }
  })
})
