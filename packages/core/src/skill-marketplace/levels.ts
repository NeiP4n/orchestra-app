export * as SkillMarketplaceLevels from "./levels.js"

import { appendFile, mkdir } from "node:fs/promises"
import path from "path"
import { Effect, Option, Schema } from "effect"
import { SkillMarketplaceStore } from "./store.js"
import type { JournalEntry, Level, NativeSkill, PortType, SkillRef, Usage } from "./types.js"
import { LEVELS } from "./types.js"

/**
 * The three levels of the native marketplace. A skill installed at the
 * society level is visible to every project and every session; a project
 * skill to its project and its sessions; a session skill only to its own
 * session. Lower levels inherit the ones above them, and a lower level
 * shadows a higher one by name: a session skill called `research` replaces
 * the project skill called `research` for that session, and the replacement
 * is visible, not silent.
 *
 * Storage is one JSON file per level, inside the level's registry directory:
 * `<dir>/skills.json` for the installed skills and `<dir>/journal.jsonl`
 * for the decisions (mismatch resolutions, installs, usage). The journal is
 * append-only and human-readable: every line is one decision with its
 * reason.
 */

export const REGISTRY_DIR = "native-skills"
export const SKILLS_FILE = "skills.json"
export const JOURNAL_FILE = "journal.jsonl"

/** Where each level's registry lives. A level without a directory is empty, not an error. */
export interface Roots {
  readonly society: string | undefined
  readonly project: string
  readonly session: string | undefined
}

const PortSchema = Schema.Struct({
  name: Schema.String,
  type: Schema.Literals(["text", "json", "list", "file", "code", "plan", "report"]),
})

const RecordSchema = Schema.Struct({
  manifest: Schema.Struct({
    name: Schema.String,
    version: Schema.String,
    purpose: Schema.String,
    inputs: Schema.Array(PortSchema),
    outputs: Schema.Array(PortSchema),
    depends: Schema.Array(Schema.Struct({ name: Schema.String, range: Schema.String })),
    rules: Schema.Array(Schema.String),
    derived: Schema.Boolean,
  }),
  level: Schema.Literals(["society", "project", "session"]),
  source: Schema.String,
  contentPath: Schema.String,
})

const RegistrySchema = Schema.Struct({ version: Schema.Number, skills: Schema.Array(RecordSchema) })

export class RegistryError extends Schema.TaggedError<RegistryError>()("@orchestra/SkillMarketplace/RegistryError", {
  message: Schema.String,
}) {}

const dirOf = (roots: Roots, level: Level): string | undefined =>
  level === "society" ? roots.society : level === "project" ? roots.project : roots.session

const registryDir = (root: string) => path.join(root, REGISTRY_DIR)

/** Reads one level's installed skills. A missing or damaged file is an empty level, not a failure. */
export const loadLevel = (roots: Roots, level: Level): Effect.Effect<readonly NativeSkill[]> =>
  Effect.gen(function* () {
    const dir = dirOf(roots, level)
    if (dir === undefined) return []
    const file = path.join(registryDir(dir), SKILLS_FILE)
    const raw = yield* Effect.tryPromise({ try: () => Bun.file(file).text(), catch: () => undefined }).pipe(Effect.option)
    if (Option.isNone(raw)) return []
    const json = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(raw.value)
    if (json._tag === "None") return []
    const parsed = Schema.decodeUnknownOption(RegistrySchema)(json.value)
    if (parsed._tag === "None" || parsed.value.version !== 1) return []
    return parsed.value.skills.map((record) => ({
      manifest: {
        name: record.manifest.name,
        version: record.manifest.version,
        purpose: record.manifest.purpose,
        inputs: record.manifest.inputs.map((port) => ({ name: port.name, type: port.type as PortType })),
        outputs: record.manifest.outputs.map((port) => ({ name: port.name, type: port.type as PortType })),
        depends: record.manifest.depends,
        rules: record.manifest.rules,
        derived: record.manifest.derived,
      },
      level: record.level,
      source: record.source,
      contentPath: record.contentPath,
    }))
  })

const saveLevel = (roots: Roots, level: Level, skills: readonly NativeSkill[]): Effect.Effect<void, RegistryError> =>
  Effect.gen(function* () {
    const dir = dirOf(roots, level)
    if (dir === undefined) return
    const target = path.join(registryDir(dir), SKILLS_FILE)
    const body = `${JSON.stringify({ version: 1, skills }, null, 2)}\n`
    yield* SkillMarketplaceStore.writeAtomic(target, body).pipe(
      Effect.mapError((error) => new RegistryError({ message: error.message })),
    )
  })

/** Appends one journal entry to a level's journal. The journal never blocks the work it records. */
export const appendJournal = (roots: Roots, level: Level, entry: JournalEntry): Effect.Effect<void> =>
  Effect.gen(function* () {
    const dir = dirOf(roots, level)
    if (dir === undefined) return
    const target = path.join(registryDir(dir), JOURNAL_FILE)
    yield* Effect.tryPromise({
      try: async () => {
        await mkdir(path.dirname(target), { recursive: true })
        await appendFile(target, `${JSON.stringify(entry)}\n`)
      },
      catch: () => undefined,
    }).pipe(Effect.result, Effect.asVoid)
  })

/** Records one use of a skill, so the rules it followed survive between runs. */
export const recordUsage = (roots: Roots, usage: Usage): Effect.Effect<void> =>
  appendJournal(roots, usage.level, {
    at: usage.at,
    kind: "usage",
    skill: usage.skill,
    level: usage.level,
    problem: `Skill "${usage.skill}" ran for "${usage.task}".`,
    decision: `Outcome ${usage.outcome}; ${usage.tokens} tokens of skill text were loaded.`,
  })

/** Installs a skill at a level, replacing a skill of the same name at that level. */
export const install = (roots: Roots, skill: NativeSkill): Effect.Effect<void, RegistryError> =>
  Effect.gen(function* () {
    const current = yield* loadLevel(roots, skill.level)
    const next = [...current.filter((entry) => entry.manifest.name !== skill.manifest.name), skill]
    yield* saveLevel(roots, skill.level, next)
    yield* appendJournal(roots, skill.level, {
      at: Date.now(),
      kind: "install",
      skill: skill.manifest.name,
      level: skill.level,
      problem: `Skill "${skill.manifest.name}" v${skill.manifest.version} installed from ${skill.source}.`,
      decision: `Installed at level ${skill.level}; a skill of the same name at this level was replaced.`,
    })
  })

/** Removes a skill from a level. Removing a skill that is not there is a no-op. */
export const uninstall = (roots: Roots, name: string, level: Level): Effect.Effect<void, RegistryError> =>
  Effect.gen(function* () {
    const current = yield* loadLevel(roots, level)
    yield* saveLevel(
      roots,
      level,
      current.filter((entry) => entry.manifest.name !== name),
    )
  })

/**
 * The skills visible to a session: society, then project, then session,
 * with a lower level shadowing a higher one by name. The returned order is
 * society first, so a reader sees the most general skills before the
 * specific ones.
 */
export const effective = (roots: Roots): Effect.Effect<readonly NativeSkill[]> =>
  Effect.gen(function* () {
    const byLevel = yield* Effect.all(LEVELS.map((level) => loadLevel(roots, level)))
    const merged = new Map<string, NativeSkill>()
    for (const [index, level] of LEVELS.entries()) {
      for (const skill of byLevel[index] ?? []) merged.set(skill.manifest.name, skill)
    }
    return [...merged.values()].sort(
      (a, b) => LEVELS.indexOf(a.level) - LEVELS.indexOf(b.level) || a.manifest.name.localeCompare(b.manifest.name),
    )
  })

/** The compact index of the effective skills: refs only, never full text. */
export const compactIndex = (skills: readonly NativeSkill[]): readonly SkillRef[] =>
  skills.map((skill) => ({
    name: skill.manifest.name,
    purpose: skill.manifest.purpose,
    version: skill.manifest.version,
    level: skill.level,
    inputs: skill.manifest.inputs,
    outputs: skill.manifest.outputs,
  }))
