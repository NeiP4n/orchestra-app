export * as ProjectFilesState from "./files-state.js"

import { appendFile, mkdir } from "node:fs/promises"
import path from "node:path"
import { Effect, Option, Schema } from "effect"
import { Orchestra } from "@orchestra/schema/orchestra"
import { Config } from "@orchestra/schema/config"
import { Federation } from "@orchestra/schema/federation"
import { Adr } from "../adr.js"
import { Dod } from "../dod.js"
import type { KV } from "../kv.js"
import { Rules } from "../rules.js"
import { SessionHandoff } from "../session/handoff.js"
import { ProjectFilesErrors } from "./errors.js"
import { ProjectFilesFormat } from "./format.js"
import { ProjectFilesPaths } from "./paths.js"
import type { SyncDeps, SyncEnv } from "./sync.js"
import type { RestoreEntry } from "./restore.js"

/**
 * State files (slice S1): the human-facing project state in `.orchestra`.
 *
 * Who owns what:
 * - `orchestra.json`, `briefing.md`, `handoffs.md`, `lifecycle.json` are
 *   file-owned: the file IS the store, so they have read/write functions
 *   and no syncer or restorer.
 * - `rules.yaml`, `society.yaml`, `budget.yaml` mirror the KV store: a
 *   syncer writes the file from KV, a restorer writes KV back from the
 *   file. The database is the truth; the file is the mirror.
 * - `tasks.yaml` and `decisions.yaml` are derived: a syncer regenerates
 *   them from `dod.yaml` / `decisions/`, and there is nothing to restore
 *   because the source is already a file.
 *
 * Every read of a corrupt file fails loudly with `ProjectFileError`
 * (kind `corrupt`), never as an empty value. Every syncer and restorer
 * only fails with `ProjectFileError`, so `syncAll` / `restoreFromFiles`
 * can report the failure per file instead of dying on it.
 */

export const RULES_FILE = "rules.yaml"
export const TASKS_FILE = "tasks.yaml"
export const DECISIONS_FILE = "decisions.yaml"
export const SOCIETY_FILE = "society.yaml"
export const BUDGET_FILE = "budget.yaml"
export const BRIEFING_FILE = "briefing.md"
export const HANDOFFS_FILE = "handoffs.md"
export const LIFECYCLE_FILE = "lifecycle.json"

const RULES_PREFIX = "rules/"
const GROUP_PREFIX = "federation/group/"

/** One rule as mirrored in `rules.yaml`: the stored rule plus its scope. */
export const RulesFile = Schema.Struct({
  rules: Schema.Array(
    Schema.Struct({
      scope: Schema.String,
      id: Schema.String,
      text: Schema.String,
      by: Schema.String,
      at: Schema.Number,
    }),
  ),
})
export interface RulesFile extends Schema.Schema.Type<typeof RulesFile> {}

/** One DoD leaf as projected in `tasks.yaml`. `zone` is the leaf's group: the kanban board treats the group as the zone. */
export const TasksFile = Schema.Struct({
  tasks: Schema.Array(
    Schema.Struct({
      task_id: Schema.String,
      owner: Schema.String.pipe(Schema.optional),
      state: Schema.String,
      zone: Schema.String.pipe(Schema.optional),
    }),
  ),
})
export interface TasksFile extends Schema.Schema.Type<typeof TasksFile> {}

/** One ADR as indexed in `decisions.yaml`. `decidedAt` is the ADR's date (YYYY-MM-DD). */
export const DecisionsFile = Schema.Struct({
  decisions: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      title: Schema.String,
      status: Schema.Literals(["proposed", "accepted", "rejected", "superseded"]),
      file: Schema.String,
      decidedAt: Schema.String,
    }),
  ),
})
export interface DecisionsFile extends Schema.Schema.Type<typeof DecisionsFile> {}

/** Every federation group of the society, as stored in KV. */
export const SocietyFile = Schema.Struct({
  groups: Schema.Array(Federation.Group),
})
export interface SocietyFile extends Schema.Schema.Type<typeof SocietyFile> {}

/** The USD spend limit of each federation group. A group without a budget has no entry. */
export const BudgetFile = Schema.Struct({
  budgets: Schema.Array(
    Schema.Struct({
      group: Schema.String,
      budgetUsd: Schema.Number,
      currency: Schema.Literal("USD"),
    }),
  ),
})
export interface BudgetFile extends Schema.Schema.Type<typeof BudgetFile> {}

export const BriefingStatus = Schema.Literals(["draft", "active", "paused", "done"])
export type BriefingStatus = typeof BriefingStatus.Type

export interface Briefing {
  readonly title: string
  readonly goal: string
  readonly status: BriefingStatus
}

export const LifecyclePhase = Schema.Literals(["planning", "active", "paused", "done", "archived"])
export type LifecyclePhase = typeof LifecyclePhase.Type

/**
 * Lifecycle state. There is no project-lifecycle store in the database —
 * the session and location lifecycles are different things, and the
 * society generation stage (`founded`/`generated`/`planned`) is the
 * society's, not the project's — so the file owns this state until a
 * project-lifecycle store exists.
 */
export const LifecycleFile = Schema.Struct({
  phase: LifecyclePhase,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  milestones: Schema.Array(
    Schema.Struct({
      title: Schema.String,
      done: Schema.Boolean,
      doneAt: Schema.String.pipe(Schema.optional),
    }),
  ),
})
export interface LifecycleFile extends Schema.Schema.Type<typeof LifecycleFile> {}

/** One entry of the `handoffs.md` log, as read back (best-effort fields: a hand-written block keeps its text with empty ids). */
export interface HandoffEntry {
  readonly sessionID: string
  readonly stoppedAt: string
  readonly reason: string
  readonly text: string
}

// A KV scan returns at most 1000 entries per page: follow `next` until the
// tail is read, or rules and groups past 1000 entries silently disappear
// from every file built on them (the same rule the federation store uses).
const scanAll = (kv: KV.Interface, prefix: string) => {
  const read = (after?: string): Effect.Effect<ReadonlyArray<KV.Entry>> =>
    kv.scan({ prefix, after, limit: 1000 }).pipe(
      Effect.flatMap((result) =>
        result.next
          ? read(result.next).pipe(Effect.map((rest) => [...result.entries, ...rest]))
          : Effect.succeed([...result.entries]),
      ),
    )
  return read()
}

// --- orchestra.json: this project's config ---------------------------------
//
// The file is the project config the config loader reads
// (`ConfigDiscovery`: `.orchestra/orchestra.json`, written there by Б9).
// Validated against the real config schema (`Config.Info` — every field
// optional, so `{}` is a valid empty config); a file that is not JSON or
// does not match the schema is corrupt, never silently an empty config.
// File-owned: the config loader reads it directly, nothing syncs it.

export const readConfig = (directory: string): Effect.Effect<Config.Info, ProjectFilesErrors.ProjectFileError> =>
  ProjectFilesFormat.readJson(ProjectFilesPaths.readPath(directory, ProjectFilesPaths.ORCHESTRA_CONFIG_FILE), Config.Info)

export const writeConfig = (
  directory: string,
  info: Config.Info,
): Effect.Effect<void, ProjectFilesErrors.ProjectFileError> =>
  Effect.gen(function* () {
    const validated = yield* Schema.decodeUnknownEffect(Config.Info)(info).pipe(
      Effect.mapError((error) =>
        ProjectFilesErrors.invalid(
          ProjectFilesPaths.ORCHESTRA_CONFIG_FILE,
          `project config is not valid: ${error.message}`,
        ),
      ),
    )
    yield* ProjectFilesFormat.writeJson(
      ProjectFilesPaths.writePath(directory, ProjectFilesPaths.ORCHESTRA_CONFIG_FILE),
      validated,
    )
  })

// --- rules.yaml: mirror of the KV rule store -------------------------------
//
// Scopes are enumerated by scanning `rules/` in KV (history keys under
// `rules/history/` are the audit trail, not rules, and are skipped). A
// scope whose stored rules are corrupt fails the sync loudly instead of
// writing a file that silently drops them.

/** Only a stable project record at this exact directory can own a rule mirror. */
const ruleScopes = (directory: string, deps: SyncDeps) => Effect.gen(function* () {
  const records = yield* scanAll(deps.kv, "orchestra/project/")
  const projects = records.flatMap((entry) => Option.toArray(Schema.decodeUnknownOption(Orchestra.Project)(entry.value)))
  const own = projects.filter((project) => path.resolve(project.directory) === path.resolve(directory))
  if (own.length !== 1) return yield* ProjectFilesErrors.invalid(RULES_FILE, "Rule mirror requires one verified project owner for this exact directory.")
  const id = own[0]!.id
  return (scope: string) => scope === Rules.projectScope(id) || scope === Rules.projectDefaultsScope(id)
    || scope === Rules.orchestratorScope(id) || scope.startsWith(`role:${id}:`)
})

export const syncRules = (
  directory: string,
  deps: SyncDeps,
): Effect.Effect<void, ProjectFilesErrors.ProjectFileError, SyncEnv> =>
  Effect.gen(function* () {
    const allowed = yield* ruleScopes(directory, deps)
    const entries = yield* scanAll(deps.kv, RULES_PREFIX)
    const scopes = entries
      .map((entry) => entry.key.slice(RULES_PREFIX.length))
      // session:<id> rules belong to one chat and die with it; mirroring them would fill the file with dead entries.
      .filter(allowed)
      .toSorted()
    const rows: Array<{ scope: string; id: string; text: string; by: string; at: number }> = []
    for (const scope of scopes) {
      const rules = yield* Rules.listStrict(deps.kv, scope).pipe(
        Effect.mapError((error) =>
          ProjectFilesErrors.corrupt(RULES_FILE, `rules scope ${scope} cannot be read: ${error.reason}`),
        ),
      )
      for (const rule of rules) rows.push({ scope, id: rule.id, text: rule.text, by: rule.by, at: rule.at })
    }
    yield* ProjectFilesFormat.writeYaml(ProjectFilesPaths.writePath(directory, RULES_FILE), { rules: rows })
  })

export const restoreRules = (
  directory: string,
  deps: SyncDeps,
): Effect.Effect<RestoreEntry, ProjectFilesErrors.ProjectFileError, SyncEnv> =>
  Effect.gen(function* () {
    const parsed = yield* ProjectFilesFormat.readYaml(
      ProjectFilesPaths.readPath(directory, RULES_FILE),
      RulesFile,
    ).pipe(
      Effect.catchTag("ProjectFiles.Error", (error) =>
        error.kind === "missing" ? Effect.succeed(undefined) : Effect.fail(error),
      ),
    )
    if (parsed === undefined) return { file: RULES_FILE, status: "skipped" as const }
    const allowed = yield* ruleScopes(directory, deps)
    // Validate the entire file before writing any row, including legacy global mirrors.
    if (parsed.rules.some((row) => !allowed(row.scope)))
      return yield* ProjectFilesErrors.invalid(RULES_FILE, "Rule mirror contains foreign or global scopes. No rules were restored.")
    const byScope = new Map<string, Array<{ id: string; text: string; by: string; at: number }>>()
    for (const row of parsed.rules) {
      const scope = byScope.get(row.scope) ?? []
      scope.push({ id: row.id, text: row.text, by: row.by, at: row.at })
      byScope.set(row.scope, scope)
    }
    for (const [scope, rules] of byScope) {
      yield* deps.kv.set(RULES_PREFIX + scope, rules as unknown as KV.Value)
    }
    return { file: RULES_FILE, status: "restored" as const, count: parsed.rules.length }
  })

// --- tasks.yaml: read-only projection of the DoD leaves --------------------
//
// Derived from `dod.yaml` through `Dod.status` (the same read the board
// uses), so a leaf the board cannot read never appears here as a task.
// No restorer: the DoD file IS the store, the projection is regenerated.

export const syncTasks = (
  directory: string,
  _deps: SyncDeps,
): Effect.Effect<void, ProjectFilesErrors.ProjectFileError, SyncEnv> =>
  Effect.gen(function* () {
    const status = yield* Dod.status(directory)
    if (status.type === "error")
      return yield* Effect.fail(
        ProjectFilesErrors.corrupt(TASKS_FILE, `dod.yaml cannot be read: ${status.reason}`),
      )
    const tasks =
      status.type === "ready"
        ? status.items.map((item) => ({
            task_id: item.id,
            ...(item.owner !== undefined ? { owner: item.owner } : {}),
            state: item.state,
            zone: item.stage,
          }))
        : []
    yield* ProjectFilesFormat.writeYaml(ProjectFilesPaths.writePath(directory, TASKS_FILE), { tasks })
  })

// --- decisions.yaml: ADR index over decisions/ -----------------------------
//
// Built from the ADR files themselves (`Adr.list`); a stray markdown file
// that is not an ADR is skipped by `Adr.list`, never fatal. No restorer:
// `decisions/` IS the store, the index is regenerated.

export const syncDecisions = (
  directory: string,
  _deps: SyncDeps,
): Effect.Effect<void, ProjectFilesErrors.ProjectFileError, SyncEnv> =>
  Effect.gen(function* () {
    const records = yield* Adr.list(directory).pipe(
      Effect.mapError((error) =>
        ProjectFilesErrors.corrupt(DECISIONS_FILE, `cannot build decisions index: ${error.message}`),
      ),
    )
    const decisions = records.map((record) => ({
      id: `ADR-${String(record.number).padStart(4, "0")}`,
      title: record.title,
      status: record.status,
      file: `${Adr.DIR}/${Adr.fileName(record.number)}`,
      decidedAt: record.date,
    }))
    yield* ProjectFilesFormat.writeYaml(ProjectFilesPaths.writePath(directory, DECISIONS_FILE), { decisions })
  })

// --- society.yaml and budget.yaml: federation groups in KV -----------------
//
// Groups live in KV under `federation/group/<name>`, encoded with the
// federation `Group` schema (name, projects, mode, supervisor, budget).
// The syncers read them the same way the federation service does (scan +
// decode); a stored group that no longer decodes fails loudly instead of
// silently disappearing from the file. The budget file is a projection of
// the same groups: the per-group USD spend limit lives on the group
// record, there is no separate budget store.

/** A mirror belongs to one registered project at the exact directory, never to the global installation. */
const stateOwner = (directory: string, deps: SyncDeps, file: string) => Effect.gen(function* () {
  const records = yield* scanAll(deps.kv, "orchestra/project/")
  const projects = records.flatMap(entry => Option.toArray(Schema.decodeUnknownOption(Orchestra.Project)(entry.value)))
  const own = projects.filter(project => path.resolve(project.directory) === path.resolve(directory))
  if (own.length !== 1) return yield* ProjectFilesErrors.invalid(file, "State mirror requires one verified project owner for this exact directory.")
  return own[0]!.id
})

const readGroups = (
  kv: KV.Interface,
  file: string,
  owner: Orchestra.ProjectID,
): Effect.Effect<ReadonlyArray<Federation.Group>, ProjectFilesErrors.ProjectFileError> =>
  Effect.gen(function* () {
    const entries = yield* scanAll(kv, GROUP_PREFIX)
    const groups: Array<Federation.Group> = []
    for (const entry of entries) {
      const raw = entry.value
      // A member project cannot export its coordinator's shared state, and foreign groups are invisible.
      if (typeof raw !== "object" || raw === null || Array.isArray(raw) || !("projects" in raw) || !Array.isArray(raw.projects) || raw.projects[0] !== owner) continue
      const group = Option.getOrUndefined(Schema.decodeUnknownOption(Federation.Group)(raw))
      if (group === undefined)
        return yield* Effect.fail(
          ProjectFilesErrors.corrupt(file, `stored group ${entry.key} does not decode as a federation group`),
        )
      groups.push(group)
    }
    return groups.toSorted((a, b) => a.name.localeCompare(b.name))
  })

const encodeGroup = (
  group: Federation.Group,
  file: string,
  kind: "write-failed" | "restore-failed",
): Effect.Effect<unknown, ProjectFilesErrors.ProjectFileError> =>
  Effect.try({
    try: () => Schema.encodeSync(Federation.Group)(group),
    catch: (error) =>
      kind === "write-failed"
        ? ProjectFilesErrors.writeFailed(file, `cannot encode group ${group.name}: ${String(error)}`)
        : ProjectFilesErrors.restoreFailed(file, `cannot encode group ${group.name}: ${String(error)}`),
  })

export const syncSociety = (
  directory: string,
  deps: SyncDeps,
): Effect.Effect<void, ProjectFilesErrors.ProjectFileError, SyncEnv> =>
  Effect.gen(function* () {
    const owner = yield* stateOwner(directory, deps, SOCIETY_FILE)
    const groups = yield* readGroups(deps.kv, SOCIETY_FILE, owner)
    const encoded: Array<unknown> = []
    for (const group of groups) encoded.push(yield* encodeGroup(group, SOCIETY_FILE, "write-failed"))
    yield* ProjectFilesFormat.writeYaml(ProjectFilesPaths.writePath(directory, SOCIETY_FILE), { groups: encoded })
  })

export const restoreSociety = (
  directory: string,
  deps: SyncDeps,
): Effect.Effect<RestoreEntry, ProjectFilesErrors.ProjectFileError, SyncEnv> =>
  Effect.gen(function* () {
    const parsed = yield* ProjectFilesFormat.readYaml(
      ProjectFilesPaths.readPath(directory, SOCIETY_FILE),
      SocietyFile,
    ).pipe(
      Effect.catchTag("ProjectFiles.Error", (error) =>
        error.kind === "missing" ? Effect.succeed(undefined) : Effect.fail(error),
      ),
    )
    if (parsed === undefined) return { file: SOCIETY_FILE, status: "skipped" as const }
    const owner = yield* stateOwner(directory, deps, SOCIETY_FILE)
    // Validate the whole file before any write. A project mirror is not permission to create cross-project links.
    for (const group of parsed.groups) {
      if (group.projects[0] !== owner) return yield* ProjectFilesErrors.invalid(SOCIETY_FILE, "Society mirror contains a foreign coordinator. Nothing was restored.")
      const raw = yield* deps.kv.get(GROUP_PREFIX + group.name)
      if (raw === undefined) {
        if (group.projects.length !== 1 || group.supervisor !== undefined) return yield* ProjectFilesErrors.invalid(SOCIETY_FILE, "Cannot recover multi-project membership or a supervisor from one project file without a verified group record.")
      } else {
        const previous = Option.getOrUndefined(Schema.decodeUnknownOption(Federation.Group)(raw))
        if (!previous) return yield* ProjectFilesErrors.corrupt(SOCIETY_FILE, "The saved group record cannot be verified.")
        if (JSON.stringify(previous.projects) !== JSON.stringify(group.projects) || Federation.modeOf(previous) !== Federation.modeOf(group) || previous.supervisor !== group.supervisor)
          return yield* ProjectFilesErrors.invalid(SOCIETY_FILE, "Society mirror changes membership, mode or supervisor. Use the authorized federation workflow instead.")
      }
    }
    for (const group of parsed.groups) {
      const encoded = yield* encodeGroup(group, SOCIETY_FILE, "restore-failed")
      yield* deps.kv.set(GROUP_PREFIX + group.name, encoded as unknown as KV.Value)
    }
    return { file: SOCIETY_FILE, status: "restored" as const, count: parsed.groups.length }
  })

export const syncBudget = (
  directory: string,
  deps: SyncDeps,
): Effect.Effect<void, ProjectFilesErrors.ProjectFileError, SyncEnv> =>
  Effect.gen(function* () {
    const owner = yield* stateOwner(directory, deps, BUDGET_FILE)
    const groups = yield* readGroups(deps.kv, BUDGET_FILE, owner)
    const budgets = groups.flatMap((group) =>
      group.budget === undefined
        ? []
        : [{ group: group.name, budgetUsd: group.budget, currency: "USD" as const }],
    )
    yield* ProjectFilesFormat.writeYaml(ProjectFilesPaths.writePath(directory, BUDGET_FILE), { budgets })
  })

export const restoreBudget = (
  directory: string,
  deps: SyncDeps,
): Effect.Effect<RestoreEntry, ProjectFilesErrors.ProjectFileError, SyncEnv> =>
  Effect.gen(function* () {
    const parsed = yield* ProjectFilesFormat.readYaml(
      ProjectFilesPaths.readPath(directory, BUDGET_FILE),
      BudgetFile,
    ).pipe(
      Effect.catchTag("ProjectFiles.Error", (error) =>
        error.kind === "missing" ? Effect.succeed(undefined) : Effect.fail(error),
      ),
    )
    if (parsed === undefined) return { file: BUDGET_FILE, status: "skipped" as const }
    const owner = yield* stateOwner(directory, deps, BUDGET_FILE)
    const updates: Array<{ key: string; encoded: unknown }> = []
    for (const entry of parsed.budgets) {
      const stored = yield* deps.kv.get(GROUP_PREFIX + entry.group)
      if (stored === undefined)
        return yield* Effect.fail(
          ProjectFilesErrors.restoreFailed(
            BUDGET_FILE,
            `no federation group named ${entry.group}: cannot restore its budget`,
          ),
        )
      const decoded = Option.getOrUndefined(Schema.decodeUnknownOption(Federation.Group)(stored))
      if (decoded === undefined)
        return yield* Effect.fail(
          ProjectFilesErrors.corrupt(
            BUDGET_FILE,
            `stored group ${entry.group} does not decode as a federation group`,
          ),
        )
      if (decoded.projects[0] !== owner) return yield* ProjectFilesErrors.invalid(BUDGET_FILE, "Budget mirror contains a group owned by another coordinator. No budgets were restored.")
      const next = yield* Schema.decodeUnknownEffect(Federation.Group)({
        ...decoded,
        budget: entry.budgetUsd,
      }).pipe(
        Effect.mapError((error) =>
          ProjectFilesErrors.restoreFailed(
            BUDGET_FILE,
            `budget for ${entry.group} is not valid: ${error.message}`,
          ),
        ),
      )
      const encoded = yield* encodeGroup(next, BUDGET_FILE, "restore-failed")
      updates.push({ key: GROUP_PREFIX + entry.group, encoded })
    }
    for (const update of updates) yield* deps.kv.set(update.key, update.encoded as KV.Value)
    return { file: BUDGET_FILE, status: "restored" as const, count: parsed.budgets.length }
  })

// --- briefing.md: file-owned project briefing -------------------------------
//
// No database source exists for a briefing (nothing in the codebase
// reads or writes one), so the file owns it. Written with title, goal
// and status sections; read back from the same shape. A briefing without
// a `# <title>` line is corrupt; a missing `- Status:` line reads as
// `draft` (hand-written briefings predate the status line).

export const renderBriefing = (briefing: Briefing): string =>
  [`# ${briefing.title}`, "", `- Status: ${briefing.status}`, "", "## Goal", briefing.goal, ""].join("\n")

export const parseBriefing = (
  file: string,
  text: string,
): Effect.Effect<Briefing, ProjectFilesErrors.ProjectFileError> =>
  Effect.gen(function* () {
    const title = /^# (.+)$/m.exec(text)?.[1]?.trim()
    if (!title)
      return yield* Effect.fail(ProjectFilesErrors.corrupt(file, `${file} has no "# <title>" line`))
    const statusRaw = /^- Status: (.+)$/m.exec(text)?.[1]?.trim()
    const status =
      statusRaw === undefined
        ? ("draft" as const)
        : Option.getOrUndefined(Schema.decodeUnknownOption(BriefingStatus)(statusRaw))
    if (status === undefined)
      return yield* Effect.fail(
        ProjectFilesErrors.corrupt(file, `${file} has unknown status ${JSON.stringify(statusRaw)}`),
      )
    const goalStart = text.indexOf("## Goal\n")
    const goal = goalStart < 0 ? "" : text.slice(goalStart + "## Goal\n".length).split("\n## ")[0].trim()
    return { title, goal, status }
  })

export const writeBriefing = (
  directory: string,
  briefing: Briefing,
): Effect.Effect<void, ProjectFilesErrors.ProjectFileError> =>
  Effect.gen(function* () {
    if (!briefing.title.trim() || !briefing.goal.trim())
      return yield* Effect.fail(
        ProjectFilesErrors.invalid(BRIEFING_FILE, "a briefing needs a title and a goal"),
      )
    yield* ProjectFilesFormat.writeText(
      ProjectFilesPaths.writePath(directory, BRIEFING_FILE),
      renderBriefing(briefing),
    )
  })

export const readBriefing = (directory: string): Effect.Effect<Briefing, ProjectFilesErrors.ProjectFileError> =>
  Effect.gen(function* () {
    const file = ProjectFilesPaths.readPath(directory, BRIEFING_FILE)
    const text = yield* ProjectFilesFormat.readText(file)
    return yield* parseBriefing(file, text)
  })

// --- handoffs.md: append-only handoff log ----------------------------------
//
// File-owned: handoffs between agents, one entry per stop, appended with
// the shape `SessionHandoff` renders (reason, what works, what does not,
// next step), headed by the session it belongs to. A missing file reads
// as an empty log, like the JSONL logs. Appends are single writes, the
// same tradeoff the DoD event log makes.

export const appendHandoff = (
  directory: string,
  sessionID: string,
  input: SessionHandoff.Input,
): Effect.Effect<void, ProjectFilesErrors.ProjectFileError> =>
  Effect.gen(function* () {
    const file = ProjectFilesPaths.writePath(directory, HANDOFFS_FILE)
    const stoppedAt = input.stoppedAt ?? new Date().toISOString()
    const body = SessionHandoff.render({ ...input, stoppedAt })
    const firstLine = `# Handoff — stopped ${stoppedAt}`
    const entry = body.startsWith(firstLine)
      ? body.replace(firstLine, `## Handoff — ${sessionID} — stopped ${stoppedAt}`)
      : `## Handoff — ${sessionID} — stopped ${stoppedAt}\n\n${body}`
    const existing = yield* ProjectFilesFormat.readText(ProjectFilesPaths.readPath(directory, HANDOFFS_FILE)).pipe(
      Effect.catchTag("ProjectFiles.Error", (error) =>
        error.kind === "missing" ? Effect.succeed("") : Effect.fail(error),
      ),
    )
    const separator = existing === "" ? "" : existing.endsWith("\n") ? "\n" : "\n\n"
    yield* Effect.tryPromise({
      try: async () => {
        await mkdir(path.dirname(file), { recursive: true })
        await appendFile(file, `${separator}${entry}`, "utf8")
      },
      catch: (error) => ProjectFilesErrors.writeFailed(file, `cannot append handoff: ${String(error)}`),
    })
  })

const parseHandoffEntry = (block: string): HandoffEntry => {
  const header = /^## Handoff — (\S+) — stopped (\S+)/.exec(block)
  const reason = /^- Reason: (.+)$/m.exec(block)?.[1]?.trim() ?? ""
  return {
    sessionID: header?.[1] ?? "",
    stoppedAt: header?.[2] ?? "",
    reason,
    text: block.trim(),
  }
}

export const readHandoffs = (directory: string): Effect.Effect<ReadonlyArray<HandoffEntry>, ProjectFilesErrors.ProjectFileError> =>
  Effect.gen(function* () {
    const text = yield* ProjectFilesFormat.readText(
      ProjectFilesPaths.readPath(directory, HANDOFFS_FILE),
    ).pipe(
      Effect.catchTag("ProjectFiles.Error", (error) =>
        error.kind === "missing" ? Effect.succeed("") : Effect.fail(error),
      ),
    )
    if (text.trim() === "") return [] as Array<HandoffEntry>
    const parts = text.split(/(^## Handoff — .+$)/m)
    const entries: Array<HandoffEntry> = []
    let current: string | undefined
    for (const part of parts) {
      if (/^## Handoff — /.test(part)) {
        if (current !== undefined) entries.push(parseHandoffEntry(current))
        current = part
      } else if (current !== undefined) {
        current += part
      } else if (part.trim() !== "") {
        entries.push({ sessionID: "", stoppedAt: "", reason: "", text: part.trim() })
      }
    }
    if (current !== undefined) entries.push(parseHandoffEntry(current))
    return entries
  })

// --- lifecycle.json: file-owned lifecycle state ----------------------------
//
// Read and write with schema validation. No syncer or restorer: no
// project-lifecycle store exists in the database (see `LifecycleFile`).

export const newLifecycle = (): LifecycleFile => {
  const now = new Date().toISOString()
  return { phase: "planning", createdAt: now, updatedAt: now, milestones: [] }
}

export const readLifecycle = (directory: string): Effect.Effect<LifecycleFile, ProjectFilesErrors.ProjectFileError> =>
  ProjectFilesFormat.readJson(ProjectFilesPaths.readPath(directory, LIFECYCLE_FILE), LifecycleFile)

export const writeLifecycle = (
  directory: string,
  value: LifecycleFile,
): Effect.Effect<void, ProjectFilesErrors.ProjectFileError> =>
  Effect.gen(function* () {
    const validated = yield* Schema.decodeUnknownEffect(LifecycleFile)(value).pipe(
      Effect.mapError((error) =>
        ProjectFilesErrors.invalid(LIFECYCLE_FILE, `lifecycle state is not valid: ${error.message}`),
      ),
    )
    yield* ProjectFilesFormat.writeJson(ProjectFilesPaths.writePath(directory, LIFECYCLE_FILE), validated)
  })
