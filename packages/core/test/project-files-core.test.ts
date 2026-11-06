import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { ProjectFiles } from "@orchestra/core/project-files/index"

// The framework functions carry the Database.Service requirement for the
// syncers/restorers they will call; the core commit registers none, so the
// service is never touched and the cast is safe here. Slice tests that
// register real syncers provide a real database layer instead.
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
  test("syncAll runs the registered syncers and reports nothing failed", async () => {
    const dir = await fixture()
    await write(dir, "dod.yaml", "task_id: X\nleaves: []\n")
    const report = await run(
      // The S3 syncers are registered, so they run: a missing mcp.yaml
      // and a missing skill registry are ok (fresh project), and
      // INTEGRATE.md is regenerated. The framework path (index + health
      // refresh) is what is tested, plus that no syncer failed.
      ProjectFiles.ProjectFilesSync.syncAll(dir, { kv: undefined as never }),
    )
    expect(report.files.length).toBeGreaterThan(0)
    expect(report.files.every((file) => file.status === "ok")).toBe(true)
    expect(report.files.map((file) => file.file)).toContain("INTEGRATE.md")
    expect(await readFile(path.join(dir, ".orchestra", "index.yaml"), "utf8")).toContain("dod.yaml")
    expect(await readFile(path.join(dir, ".orchestra", "health.json"), "utf8")).toContain("checkedAt")
  })

  test("restoreFromFiles runs the registered restorers, reports nothing failed, refreshes index and health", async () => {
    const dir = await fixture()
    await write(dir, "dod.yaml", "task_id: X\nleaves: []\n")
    const report = await run(
      // The S3 restorers are registered, so they run: file-owned state
      // is skipped, INTEGRATE.md is regenerated. Nothing fails on a
      // fresh project, and the framework path (index + health refresh)
      // is what is tested.
      ProjectFiles.ProjectFilesRestore.restoreFromFiles(dir, { kv: undefined as never }),
    )
    expect(report.entries.length).toBeGreaterThan(0)
    expect(report.entries.every((entry) => entry.status !== "failed")).toBe(true)
    expect(report.entries.map((entry) => entry.file)).toContain("INTEGRATE.md")
    expect(await readFile(path.join(dir, ".orchestra", "index.yaml"), "utf8")).toContain("dod.yaml")
  })

  test("every git-tracked file has a negation in the repo root .gitignore", async () => {
    const gitignore = await readFile(path.join(import.meta.dir, "..", "..", "..", ".gitignore"), "utf8")
    for (const line of ProjectFiles.ProjectFilesRegistry.gitignoreLines()) {
      expect(gitignore).toContain(`${line}\n`)
    }
  })
})
