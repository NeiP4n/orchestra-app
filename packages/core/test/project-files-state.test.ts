import { describe, expect } from "bun:test"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect, Schema } from "effect"
import { AppNodeBuilder } from "@orchestra/core/effect/app-node-builder"
import { LayerNode } from "@orchestra/util/effect/layer-node"
import { Global } from "@orchestra/util/global"
import { Database } from "@orchestra/core/database/database"
import { KV } from "@orchestra/core/kv"
import { Rules } from "@orchestra/core/rules"
import { Adr } from "@orchestra/core/adr"
import { Federation } from "@orchestra/schema/federation"
import { ProjectFiles } from "@orchestra/core/project-files/index"
import { ProjectFilesState } from "@orchestra/core/project-files/files-state"
import { tempGlobalLayer } from "./fixture/global"
import { testEffect } from "./lib/effect"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, KV.node]), [Global.node.replace(tempGlobalLayer)]),
)

const fixture = async (): Promise<string> => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "orchestra-project-files-state-"))
  await mkdir(path.join(dir, ".orchestra"), { recursive: true })
  return dir
}

const write = async (dir: string, rel: string, contents: string): Promise<void> => {
  const file = path.join(dir, ".orchestra", rel)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, contents, "utf8")
}

const read = (dir: string, rel: string): Promise<string> => readFile(path.join(dir, ".orchestra", rel), "utf8")

const seedGroup = (kv: KV.Interface, name: string, budget?: number) =>
  Effect.gen(function* () {
    const group = Schema.decodeUnknownSync(Federation.Group)({
      name,
      projects: ["prj-a"],
      mode: "council",
      ...(budget !== undefined ? { budget } : {}),
    })
    yield* kv.set(
      `federation/group/${name}`,
      Schema.encodeSync(Federation.Group)(group) as unknown as KV.Value,
    )
    return group
  })

describe("ProjectFiles state: orchestra.json", () => {
  it.live("writes and reads the project config, validated against the real config schema", () =>
    Effect.gen(function* () {
      const dir = yield* Effect.tryPromise(() => fixture())
      yield* ProjectFilesState.writeConfig(dir, { username: "satria", shell: "/bin/bash" })
      const back = yield* ProjectFilesState.readConfig(dir)
      expect(back.username).toBe("satria")
      expect(back.shell).toBe("/bin/bash")
      yield* ProjectFilesState.writeConfig(dir, {})
      expect(yield* ProjectFilesState.readConfig(dir)).toEqual({})
    }),
  )

  it.live("a config that is not JSON, or does not match the schema, is corrupt — never an empty config", () =>
    Effect.gen(function* () {
      const dir = yield* Effect.tryPromise(() => fixture())
      yield* Effect.tryPromise(() => write(dir, "orchestra.json", "{not json\n"))
      const badJson = yield* Effect.exit(ProjectFilesState.readConfig(dir))
      expect(badJson._tag).toBe("Failure")
      yield* Effect.tryPromise(() => write(dir, "orchestra.json", '{"model": 42}\n'))
      const badShape = yield* Effect.exit(ProjectFilesState.readConfig(dir))
      expect(badShape._tag).toBe("Failure")
      const invalidWrite = yield* Effect.exit(
        ProjectFilesState.writeConfig(dir, { username: 42 } as never),
      )
      expect(invalidWrite._tag).toBe("Failure")
      const missing = yield* Effect.exit(ProjectFilesState.readConfig(yield* Effect.tryPromise(() => fixture())))
      expect(missing._tag).toBe("Failure")
    }),
  )
})

describe("ProjectFiles state: rules.yaml", () => {
  it.live("syncs every scope from KV and skips the history keys", () =>
    Effect.gen(function* () {
      const dir = yield* Effect.tryPromise(() => fixture())
      const kv = yield* KV.Service
      yield* Rules.add(kv, Rules.GLOBAL, { text: "Never edit generated files.", by: "operator" })
      yield* Rules.add(kv, Rules.projectScope("proj-a"), { text: "Tests before code.", by: "team-dev" })
      yield* ProjectFilesState.syncRules(dir, { kv })
      const text = yield* Effect.tryPromise(() => read(dir, "rules.yaml"))
      expect(text).toContain("Never edit generated files.")
      expect(text).toContain("Tests before code.")
      expect(text).toContain("global")
      expect(text).toContain("project:proj-a")
      expect(text).not.toContain("history")
    }),
  )

  it.live("restores the rules into KV after the KV rows are deleted", () =>
    Effect.gen(function* () {
      const dir = yield* Effect.tryPromise(() => fixture())
      const kv = yield* KV.Service
      yield* Rules.add(kv, Rules.GLOBAL, { text: "Never edit generated files.", by: "operator" })
      yield* Rules.add(kv, Rules.projectScope("proj-a"), { text: "Tests before code.", by: "team-dev" })
      yield* ProjectFilesState.syncRules(dir, { kv })
      yield* kv.remove(`rules/${Rules.GLOBAL}`)
      yield* kv.remove(`rules/${Rules.projectScope("proj-a")}`)
      expect(yield* Rules.list(kv, Rules.GLOBAL)).toEqual([])
      expect(yield* Rules.list(kv, Rules.projectScope("proj-a"))).toEqual([])
      const report = yield* ProjectFiles.ProjectFilesRestore.restoreFromFiles(dir, { kv })
      const rules = report.entries.find((entry) => entry.file === "rules.yaml")
      expect(rules?.status).toBe("restored")
      expect(rules?.count).toBe(2)
      expect((yield* Rules.list(kv, Rules.GLOBAL)).map((rule) => rule.text)).toEqual([
        "Never edit generated files.",
      ])
      expect((yield* Rules.list(kv, Rules.projectScope("proj-a"))).map((rule) => rule.text)).toEqual([
        "Tests before code.",
      ])
    }),
  )

  it.live("a corrupt rules file fails the restore loudly; a missing one is skipped", () =>
    Effect.gen(function* () {
      const dir = yield* Effect.tryPromise(() => fixture())
      const kv = yield* KV.Service
      const skipped = yield* ProjectFilesState.restoreRules(dir, { kv })
      expect(skipped.status).toBe("skipped")
      yield* Effect.tryPromise(() => write(dir, "rules.yaml", "rules: not-a-list\n"))
      const corrupt = yield* Effect.exit(ProjectFilesState.restoreRules(dir, { kv }))
      expect(corrupt._tag).toBe("Failure")
    }),
  )
})

describe("ProjectFiles state: tasks.yaml", () => {
  it.live("projects the DoD leaves with owner, state and zone", () =>
    Effect.gen(function* () {
      const dir = yield* Effect.tryPromise(() => fixture())
      const kv = yield* KV.Service
      yield* Effect.tryPromise(() =>
        write(
          dir,
          "dod.yaml",
          [
            "task_id: PROJECT-BOARD",
            "stages: []",
            "leaves:",
            "  - id: T-1",
            "    what: First task",
            "    group: backend",
            "    task_state: IN_PROGRESS",
            "    owner: alice",
            "    steps:",
            '      - "[x] done step"',
            '      - "[ ] todo step"',
            "  - id: T-2",
            "    what: Second task",
            "    task_state: NOT_STARTED",
            "",
          ].join("\n"),
        ),
      )
      yield* ProjectFilesState.syncTasks(dir, { kv })
      const parsed = yield* ProjectFiles.ProjectFilesFormat.readYaml(
        path.join(dir, ".orchestra", "tasks.yaml"),
        ProjectFilesState.TasksFile,
      )
      expect(parsed.tasks).toHaveLength(2)
      expect(parsed.tasks[0]).toEqual({ task_id: "T-1", owner: "alice", state: "IN_PROGRESS", zone: "backend" })
      expect(parsed.tasks[1]).toEqual({ task_id: "T-2", state: "NOT_STARTED", zone: "Ungrouped" })
    }),
  )

  it.live("no board syncs an empty list; a corrupt board fails loudly", () =>
    Effect.gen(function* () {
      const dir = yield* Effect.tryPromise(() => fixture())
      const kv = yield* KV.Service
      yield* ProjectFilesState.syncTasks(dir, { kv })
      const empty = yield* ProjectFiles.ProjectFilesFormat.readYaml(
        path.join(dir, ".orchestra", "tasks.yaml"),
        ProjectFilesState.TasksFile,
      )
      expect(empty.tasks).toEqual([])
      yield* Effect.tryPromise(() => write(dir, "dod.yaml", "task_id: [broken\n"))
      const corrupt = yield* Effect.exit(ProjectFilesState.syncTasks(dir, { kv }))
      expect(corrupt._tag).toBe("Failure")
    }),
  )
})

describe("ProjectFiles state: decisions.yaml", () => {
  it.live("indexes the ADR records with id, title, status, file and date", () =>
    Effect.gen(function* () {
      const dir = yield* Effect.tryPromise(() => fixture())
      const kv = yield* KV.Service
      yield* Adr.create(dir, { title: "Use SQLite", context: "We need storage.", decision: "SQLite via Drizzle." })
      yield* Adr.create(dir, {
        title: "No checkpoints",
        context: "Checkpoints do not exist.",
        decision: "Do not build them.",
        status: "proposed",
      })
      yield* ProjectFilesState.syncDecisions(dir, { kv })
      const parsed = yield* ProjectFiles.ProjectFilesFormat.readYaml(
        path.join(dir, ".orchestra", "decisions.yaml"),
        ProjectFilesState.DecisionsFile,
      )
      expect(parsed.decisions).toHaveLength(2)
      expect(parsed.decisions[0]).toMatchObject({
        id: "ADR-0001",
        title: "Use SQLite",
        status: "accepted",
        file: "decisions/adr-0001.md",
      })
      expect(parsed.decisions[0].decidedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(parsed.decisions[1]).toMatchObject({ id: "ADR-0002", title: "No checkpoints", status: "proposed" })
    }),
  )

  it.live("no decisions directory syncs an empty index", () =>
    Effect.gen(function* () {
      const dir = yield* Effect.tryPromise(() => fixture())
      const kv = yield* KV.Service
      yield* ProjectFilesState.syncDecisions(dir, { kv })
      const parsed = yield* ProjectFiles.ProjectFilesFormat.readYaml(
        path.join(dir, ".orchestra", "decisions.yaml"),
        ProjectFilesState.DecisionsFile,
      )
      expect(parsed.decisions).toEqual([])
    }),
  )
})

describe("ProjectFiles state: society.yaml and budget.yaml", () => {
  it.live("syncs groups from KV, with budgets only for groups that have one", () =>
    Effect.gen(function* () {
      const dir = yield* Effect.tryPromise(() => fixture())
      const kv = yield* KV.Service
      yield* seedGroup(kv, "shop", 50)
      yield* seedGroup(kv, "lab")
      yield* ProjectFilesState.syncSociety(dir, { kv })
      yield* ProjectFilesState.syncBudget(dir, { kv })
      const society = yield* ProjectFiles.ProjectFilesFormat.readYaml(
        path.join(dir, ".orchestra", "society.yaml"),
        ProjectFilesState.SocietyFile,
      )
      expect(society.groups.map((group) => group.name)).toEqual(["lab", "shop"])
      expect(Number(society.groups.find((group) => group.name === "shop")?.budget)).toBe(50)
      const budget = yield* ProjectFiles.ProjectFilesFormat.readYaml(
        path.join(dir, ".orchestra", "budget.yaml"),
        ProjectFilesState.BudgetFile,
      )
      expect(budget.budgets).toEqual([{ group: "shop", budgetUsd: 50, currency: "USD" }])
    }),
  )

  it.live("restores groups and budgets into KV after the KV rows are deleted", () =>
    Effect.gen(function* () {
      const dir = yield* Effect.tryPromise(() => fixture())
      const kv = yield* KV.Service
      yield* seedGroup(kv, "shop", 50)
      yield* ProjectFilesState.syncSociety(dir, { kv })
      yield* ProjectFilesState.syncBudget(dir, { kv })
      yield* kv.remove("federation/group/shop")
      expect(yield* kv.get("federation/group/shop")).toBeUndefined()
      const report = yield* ProjectFiles.ProjectFilesRestore.restoreFromFiles(dir, { kv })
      expect(report.entries.find((entry) => entry.file === "society.yaml")?.status).toBe("restored")
      expect(report.entries.find((entry) => entry.file === "budget.yaml")?.status).toBe("restored")
      const stored = yield* kv.get("federation/group/shop")
      const group = Schema.decodeUnknownSync(Federation.Group)(stored)
      expect(group.name).toBe("shop")
      expect(Number(group.budget)).toBe(50)
    }),
  )

  it.live("a corrupt society file fails the restore loudly; a budget for a missing group fails, not silently", () =>
    Effect.gen(function* () {
      const dir = yield* Effect.tryPromise(() => fixture())
      const kv = yield* KV.Service
      yield* Effect.tryPromise(() => write(dir, "society.yaml", "groups: not-a-list\n"))
      const corrupt = yield* Effect.exit(ProjectFilesState.restoreSociety(dir, { kv }))
      expect(corrupt._tag).toBe("Failure")
      yield* Effect.tryPromise(() =>
        write(dir, "budget.yaml", "budgets:\n  - group: ghost\n    budgetUsd: 10\n    currency: USD\n"),
      )
      const report = yield* ProjectFiles.ProjectFilesRestore.restoreFromFiles(dir, { kv })
      const budget = report.entries.find((entry) => entry.file === "budget.yaml")
      expect(budget?.status).toBe("failed")
      expect(budget?.error).toContain("ghost")
    }),
  )
})

describe("ProjectFiles state: briefing.md", () => {
  it.live("writes and reads a briefing with title, goal and status", () =>
    Effect.gen(function* () {
      const dir = yield* Effect.tryPromise(() => fixture())
      yield* ProjectFilesState.writeBriefing(dir, {
        title: "Shop rebuild",
        goal: "Rebuild the shop backend in six weeks.",
        status: "active",
      })
      const back = yield* ProjectFilesState.readBriefing(dir)
      expect(back).toEqual({ title: "Shop rebuild", goal: "Rebuild the shop backend in six weeks.", status: "active" })
      const text = yield* Effect.tryPromise(() => read(dir, "briefing.md"))
      expect(text).toContain("# Shop rebuild")
      expect(text).toContain("- Status: active")
      expect(text).toContain("## Goal")
    }),
  )

  it.live("a briefing without a title or with an unknown status is corrupt; an empty one is invalid", () =>
    Effect.gen(function* () {
      const dir = yield* Effect.tryPromise(() => fixture())
      yield* Effect.tryPromise(() => write(dir, "briefing.md", "## Goal\nDo things.\n"))
      const noTitle = yield* Effect.exit(ProjectFilesState.readBriefing(dir))
      expect(noTitle._tag).toBe("Failure")
      yield* Effect.tryPromise(() =>
        write(dir, "briefing.md", "# Title\n\n- Status: flying\n\n## Goal\nDo things.\n"),
      )
      const badStatus = yield* Effect.exit(ProjectFilesState.readBriefing(dir))
      expect(badStatus._tag).toBe("Failure")
      const empty = yield* Effect.exit(
        ProjectFilesState.writeBriefing(dir, { title: " ", goal: "x", status: "draft" }),
      )
      expect(empty._tag).toBe("Failure")
      const missing = yield* Effect.exit(
        ProjectFilesState.readBriefing(yield* Effect.tryPromise(() => fixture())),
      )
      expect(missing._tag).toBe("Failure")
    }),
  )
})

describe("ProjectFiles state: handoffs.md", () => {
  it.live("appends handoffs and reads them back in order", () =>
    Effect.gen(function* () {
      const dir = yield* Effect.tryPromise(() => fixture())
      expect(yield* ProjectFilesState.readHandoffs(dir)).toEqual([])
      yield* ProjectFilesState.appendHandoff(dir, "ses_first", {
        reason: "user",
        stoppedAt: "2026-11-06T10:00:00.000Z",
        works: "The board loads.",
        broken: "Sync is slow.",
        nextStep: "Profile the sync.",
      })
      yield* ProjectFilesState.appendHandoff(dir, "ses_second", {
        reason: "failed",
        stoppedAt: "2026-11-06T11:00:00.000Z",
        works: "Nothing yet.",
        nextStep: "Retry after the fix.",
      })
      const entries = yield* ProjectFilesState.readHandoffs(dir)
      expect(entries).toHaveLength(2)
      expect(entries[0].sessionID).toBe("ses_first")
      expect(entries[0].reason).toBe("user")
      expect(entries[0].stoppedAt).toBe("2026-11-06T10:00:00.000Z")
      expect(entries[0].text).toContain("The board loads.")
      expect(entries[1].sessionID).toBe("ses_second")
      expect(entries[1].reason).toBe("failed")
      expect(entries[1].text).toContain("Retry after the fix.")
    }),
  )
})

describe("ProjectFiles state: lifecycle.json", () => {
  it.live("writes and reads lifecycle state with milestones", () =>
    Effect.gen(function* () {
      const dir = yield* Effect.tryPromise(() => fixture())
      const created = ProjectFilesState.newLifecycle()
      expect(created.phase).toBe("planning")
      expect(created.milestones).toEqual([])
      const value = {
        ...created,
        phase: "active" as const,
        milestones: [{ title: "First society running", done: true, doneAt: "2026-11-06T10:00:00.000Z" }],
      }
      yield* ProjectFilesState.writeLifecycle(dir, value)
      expect(yield* ProjectFilesState.readLifecycle(dir)).toEqual(value)
    }),
  )

  it.live("a corrupt lifecycle file, or an unknown phase, fails loudly", () =>
    Effect.gen(function* () {
      const dir = yield* Effect.tryPromise(() => fixture())
      yield* Effect.tryPromise(() => write(dir, "lifecycle.json", "{not json\n"))
      const badJson = yield* Effect.exit(ProjectFilesState.readLifecycle(dir))
      expect(badJson._tag).toBe("Failure")
      yield* Effect.tryPromise(() =>
        write(
          dir,
          "lifecycle.json",
          '{"phase": "flying", "createdAt": "2026-11-06T00:00:00.000Z", "updatedAt": "2026-11-06T00:00:00.000Z", "milestones": []}\n',
        ),
      )
      const badPhase = yield* Effect.exit(ProjectFilesState.readLifecycle(dir))
      expect(badPhase._tag).toBe("Failure")
    }),
  )
})

describe("ProjectFiles state: syncAll and restoreFromFiles", () => {
  it.live("syncAll writes every state mirror and restoreFromFiles brings the KV state back", () =>
    Effect.gen(function* () {
      const dir = yield* Effect.tryPromise(() => fixture())
      const kv = yield* KV.Service
      yield* Rules.add(kv, Rules.GLOBAL, { text: "Never edit generated files.", by: "operator" })
      yield* seedGroup(kv, "shop", 25)
      yield* Effect.tryPromise(() =>
        write(
          dir,
          "dod.yaml",
          ["task_id: PROJECT-BOARD", "stages: []", "leaves:", "  - id: T-1", "    task_state: DONE", ""].join("\n"),
        ),
      )
      yield* Adr.create(dir, { title: "Use SQLite", context: "We need storage.", decision: "SQLite." })
      const synced = yield* ProjectFiles.ProjectFilesSync.syncAll(dir, { kv })
      const syncedByFile = new Map(synced.files.map((file) => [file.file, file.status]))
      for (const file of ["budget.yaml", "decisions.yaml", "rules.yaml", "society.yaml", "tasks.yaml"]) {
        expect(syncedByFile.get(file)).toBe("ok")
      }
      yield* kv.remove(`rules/${Rules.GLOBAL}`)
      yield* kv.remove("federation/group/shop")
      const restored = yield* ProjectFiles.ProjectFilesRestore.restoreFromFiles(dir, { kv })
      const restoredByFile = new Map(restored.entries.map((entry) => [entry.file, entry.status]))
      for (const file of ["budget.yaml", "rules.yaml", "society.yaml"]) {
        expect(restoredByFile.get(file)).toBe("restored")
      }
      expect((yield* Rules.list(kv, Rules.GLOBAL)).map((rule) => rule.text)).toEqual([
        "Never edit generated files.",
      ])
      expect(Number(Schema.decodeUnknownSync(Federation.Group)(yield* kv.get("federation/group/shop")).budget)).toBe(25)
    }),
  )

  it.live("every state file is registered in the index", () =>
    Effect.gen(function* () {
      const rels = ProjectFiles.ProjectFilesRegistry.allDescriptors().map((entry) => entry.rel)
      for (const rel of [
        "orchestra.json",
        "rules.yaml",
        "tasks.yaml",
        "decisions.yaml",
        "decisions/",
        "society.yaml",
        "budget.yaml",
        "briefing.md",
        "handoffs.md",
        "lifecycle.json",
      ]) {
        expect(rels).toContain(rel)
      }
    }),
  )
})
