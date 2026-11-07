export * as SkillMarketplaceLevels from "./levels.js"

import { appendFile, mkdir, readFile, rename, rm, stat } from "node:fs/promises"
import path from "path"
import { Effect, Option, Result, Schema } from "effect"
import { Flock } from "@orchestra/util/flock"
// Levels are plain functions with no layer, but the lock below needs Flock's
// global (the state directory). Importing Global sets it as a module side
// effect, so the lock never throws "Flock global not set" no matter who
// imports this module first.
import "@orchestra/util/global"
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

/**
 * A3-12: the journal is append-only — one line per install and per skill
 * run — and nothing ever rotated it. At this size it rolls over to
 * `journal.jsonl.1` (one older copy kept); rotation never blocks the work
 * the journal records.
 */
export const JOURNAL_MAX_BYTES = 256 * 1024

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

const registryFile = (roots: Roots, level: Level): string | undefined => {
  const dir = dirOf(roots, level)
  return dir === undefined ? undefined : path.join(registryDir(dir), SKILLS_FILE)
}

const code = (error: unknown): string =>
  error !== null && typeof error === "object" && "code" in error ? String(error.code) : ""

const message = (error: unknown): string => (error instanceof globalThis.Error ? error.message : String(error))

const toSkill = (record: {
  manifest: {
    name: string
    version: string
    purpose: string
    inputs: ReadonlyArray<{ name: string; type: PortType }>
    outputs: ReadonlyArray<{ name: string; type: PortType }>
    depends: ReadonlyArray<{ name: string; range: string }>
    rules: ReadonlyArray<string>
    derived: boolean
  }
  level: Level
  source: string
  contentPath: string
}): NativeSkill => ({
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
})

/**
 * What one level's registry file holds — the rows, plus whether the file
 * itself is damaged. A missing file is an empty level, not damage (a fresh
 * project has no registry yet); a file that exists but cannot be read or
 * parsed is damage, and the caller must know: the level reads as empty, and
 * installing over it would destroy the damaged file (A3-09). The same shape
 * as the catalog store's `Index` (`store.ts`), which this module used to
 * contradict by returning `[]` silently.
 */
export interface LevelLoad {
  readonly skills: readonly NativeSkill[]
  readonly degraded: boolean
  readonly damage: string | undefined
}

const emptyLoad: LevelLoad = { skills: [], degraded: false, damage: undefined }
const damaged = (damage: string): LevelLoad => ({ skills: [], degraded: true, damage })

/** Reads one level's installed skills, saying honestly when its registry is damaged. */
export const loadLevelDetailed = (roots: Roots, level: Level): Effect.Effect<LevelLoad> =>
  Effect.gen(function* () {
    const file = registryFile(roots, level)
    if (file === undefined) return emptyLoad
    const read = yield* Effect.tryPromise({ try: () => readFile(file, "utf8"), catch: (cause) => cause }).pipe(
      Effect.result,
    )
    if (Result.isFailure(read))
      return code(read.failure) === "ENOENT" ? emptyLoad : damaged(`the registry file cannot be read: ${message(read.failure)}`)
    const json = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))(read.success)
    if (Option.isNone(json)) return damaged("the registry file is not valid JSON")
    const parsed = Schema.decodeUnknownOption(RegistrySchema)(json.value)
    if (Option.isNone(parsed) || parsed.value.version !== 1)
      return damaged("the registry file is not a level registry (expected version 1)")
    return { skills: parsed.value.skills.map(toSkill), degraded: false, damage: undefined }
  })

/**
 * Reads one level's installed skills. A missing file is an empty level, not
 * a failure. A damaged file is also an empty level — but loudly: the damage
 * is logged with the file path, so "no skills" never hides "registry broken".
 * Installing or uninstalling over a damaged registry is refused (see below).
 */
export const loadLevel = (roots: Roots, level: Level): Effect.Effect<readonly NativeSkill[]> =>
  loadLevelDetailed(roots, level).pipe(
    Effect.tap((loaded) =>
      loaded.degraded
        ? Effect.logWarning("skill registry is damaged; the level reads as empty", {
            level,
            damage: loaded.damage,
          })
        : Effect.void,
    ),
    Effect.map((loaded) => loaded.skills),
  )

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
        // A3-12: rotate at the size cap, keeping one older copy. Rotation is
        // best-effort like the append itself: any failure here still ends in
        // the append attempt below, and the journal never fails its caller.
        try {
          if ((await stat(target)).size >= JOURNAL_MAX_BYTES) {
            await rm(`${target}.1`, { force: true })
            await rename(target, `${target}.1`)
          }
        } catch {
          // No journal yet, or rotation failed: append anyway.
        }
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

/**
 * Installs a skill at a level, replacing a skill of the same name at that level.
 *
 * A3-09: installing over a damaged registry is refused — the old code read
 * the damage as `[]` and saved an empty registry over it, destroying the
 * file. A3-10: the load→save runs under a Flock, so two parallel installs
 * of different skills at one level cannot lose one of them.
 */
export const install = (roots: Roots, skill: NativeSkill): Effect.Effect<void, RegistryError> =>
  locked(roots, skill.level, "install",
    Effect.gen(function* () {
      const loaded = yield* loadLevelDetailed(roots, skill.level)
      if (loaded.degraded)
        return yield* new RegistryError({
          message:
            `Refusing to install over a damaged ${skill.level} registry ` +
            `(${registryFile(roots, skill.level)}): ${loaded.damage}. ` +
            `Fix or remove the file, then install again.`,
        })
      const next = [...loaded.skills.filter((entry) => entry.manifest.name !== skill.manifest.name), skill]
      yield* saveLevel(roots, skill.level, next)
      yield* appendJournal(roots, skill.level, {
        at: Date.now(),
        kind: "install",
        skill: skill.manifest.name,
        level: skill.level,
        problem: `Skill "${skill.manifest.name}" v${skill.manifest.version} installed from ${skill.source}.`,
        decision: `Installed at level ${skill.level}; a skill of the same name at this level was replaced.`,
      })
    }),
  )

/**
 * Removes a skill from a level. Removing a skill that is not there is a no-op.
 * Refuses over a damaged registry, like install (A3-09), and serializes with
 * installs under the same lock (A3-10).
 */
export const uninstall = (roots: Roots, name: string, level: Level): Effect.Effect<void, RegistryError> =>
  locked(roots, level, "uninstall",
    Effect.gen(function* () {
      const loaded = yield* loadLevelDetailed(roots, level)
      if (loaded.degraded)
        return yield* new RegistryError({
          message:
            `Refusing to uninstall over a damaged ${level} registry ` +
            `(${registryFile(roots, level)}): ${loaded.damage}. ` +
            `Fix or remove the file, then uninstall again.`,
        })
      yield* saveLevel(
        roots,
        level,
        loaded.skills.filter((entry) => entry.manifest.name !== name),
      )
    }),
  )

// Serialize one level's load→save across processes (A3-10), the way Zones
// does. A level without a directory has nothing to lock.
const locked = <A>(
  roots: Roots,
  level: Level,
  operation: string,
  effect: Effect.Effect<A, RegistryError>,
): Effect.Effect<A, RegistryError> => {
  const dir = dirOf(roots, level)
  if (dir === undefined) return effect
  return Effect.scoped(
    Flock.effect(`skill-levels:${path.resolve(registryDir(dir))}`).pipe(
      Effect.andThen(effect),
      Effect.mapError((cause) =>
        cause instanceof RegistryError
          ? cause
          : new RegistryError({
              message: `Could not lock the ${level} skill registry to ${operation}: ${String(cause)}`,
            }),
      ),
    ),
  )
}

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
    for (const index of LEVELS.keys()) {
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
