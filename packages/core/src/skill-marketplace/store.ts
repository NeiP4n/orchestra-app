export * as SkillMarketplaceStore from "./store.js"

import crypto from "crypto"
import fs from "fs/promises"
import path from "path"
import { Effect, Option, Result, Schema } from "effect"
import { SkillMarketplace } from "@orchestra/schema/skill-marketplace"

/**
 * The cache lives inside the project, beside the other `.opencode` state, so what an agent can
 * find is what this project already knows: the directory travels with the repository, and two
 * projects never share an answer about what they have seen.
 */
export const DIRECTORY = ".opencode/skill-catalog"

/** Layout version; an index written by another version counts as damaged rather than guessed at. */
export const VERSION = 1

/**
 * The identifier every request to the catalog and to GitHub carries. This project's own name,
 * not the retired proxy's, because the traffic no longer goes through that proxy.
 */
export const USER_AGENT = "opencode-skill-catalog/1.0"

/**
 * A line longer than this means the file is not the NDJSON this module writes. Refusing it
 * keeps one runaway line from turning a load into an out-of-memory crash.
 */
const LINE_LIMIT = 64 * 1024

export class StoreError extends Schema.TaggedError<StoreError>()("@orchestra/SkillMarketplace/StoreError", {
  message: Schema.String,
}) {}

export type Skill = SkillMarketplace.Skill
export type SkillID = SkillMarketplace.SkillID

/**
 * The rows, plus what is known about the file they came from.
 *
 * A damaged file yields an empty cache with `degraded` set rather than an error: an agent asking
 * the catalog a question has to get "nothing cached here" back, not a broken tool. The marker is
 * the honest record of why it is empty.
 */
export interface Index {
  readonly skills: ReadonlyMap<SkillID, Skill>
  readonly degraded: boolean
  readonly damage: string | undefined
}

/** When the cache was last written, so a reader can say how old its answer is. */
export interface Meta {
  readonly updatedAt: number | undefined
}

export const emptyMeta: Meta = { updatedAt: undefined }

export const paths = (directory: string) => ({
  directory,
  skills: path.join(directory, "skills.jsonl"),
  meta: path.join(directory, "meta.json"),
})

const metaSchema = Schema.Struct({ version: Schema.Number, updatedAt: Schema.Number })

/** The raw error, not the wrapper `tryPromise` puts around one, so messages stay readable. */
const attempt = <A>(run: () => Promise<A>) => Effect.tryPromise({ try: run, catch: (error: unknown) => error })

/**
 * Reads the cache. It cannot fail: every outcome — never written, unreadable, damaged — ends in
 * a cache that says which one it was. A file that was never written is not damage: a fresh
 * project has no cache yet, and reporting damage there would cry wolf on every first search.
 */
export const load = (directory: string): Effect.Effect<Index> =>
  Effect.gen(function* () {
    const read = yield* attempt(() => fs.readFile(paths(directory).skills, "utf8")).pipe(Effect.result)
    if (Result.isFailure(read))
      return absent(read.failure)
        ? { skills: new Map(), degraded: false, damage: undefined }
        : damaged(`the cache file cannot be read: ${message(read.failure)}`)
    return indexOf(read.success)
  })

const indexOf = (raw: string): Index => {
  if (raw.trim() === "") return { skills: new Map(), degraded: false, damage: undefined }
  const lines = raw.split("\n")
  if (lines.at(-1) === "") lines.pop()
  const skills = new Map<SkillID, Skill>()
  for (const [index, line] of lines.entries()) {
    // One bad line costs the whole cache on purpose: half a catalog would answer queries with a
    // plausible subset, and neither the agent nor the reader could tell it from the truth.
    if (line.length > LINE_LIMIT) return damaged(`line ${index + 1} is ${line.length} characters long`)
    const parsed = Schema.decodeUnknownOption(SkillMarketplace.Skill)(safeParse(line))
    if (Option.isNone(parsed)) return damaged(`line ${index + 1} is not a catalog skill row`)
    skills.set(parsed.value.id, parsed.value)
  }
  return { skills, degraded: false, damage: undefined }
}

const damaged = (damage: string): Index => ({ skills: new Map(), degraded: true, damage })

/** Meta is provenance, not data: a damaged one answers with "never written" and leaves the rows. */
export const loadMeta = (directory: string): Effect.Effect<Meta> =>
  Effect.gen(function* () {
    const read = yield* attempt(() => fs.readFile(paths(directory).meta, "utf8")).pipe(Effect.option)
    if (Option.isNone(read)) return emptyMeta
    const decoded = Schema.decodeUnknownOption(metaSchema)(safeParse(read.value))
    if (Option.isNone(decoded) || decoded.value.version !== VERSION) return emptyMeta
    return { updatedAt: decoded.value.updatedAt === 0 ? undefined : decoded.value.updatedAt }
  })

/**
 * Replaces one file in one atomic step: a temporary file beside the destination is written and
 * renamed over it, so a crash or a full disk leaves the previous file intact. Shared with the
 * skill-text writers, which have the same reason to be all-or-nothing.
 */
export const writeAtomic = (destination: string, contents: string): Effect.Effect<void, StoreError> =>
  attempt(async () => {
    await fs.mkdir(path.dirname(destination), { recursive: true })
    const temporary = `${destination}.${process.pid}.${crypto.randomUUID()}.tmp`
    try {
      await fs.writeFile(temporary, contents)
      await fs.rename(temporary, destination)
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => undefined)
      throw error
    }
  }).pipe(failed(`write ${path.basename(destination)}`))

/**
 * Replaces the cache in one atomic step: a temporary file in the same directory is written and
 * renamed over the destination, so an interrupted write leaves the previous cache readable.
 * Rewriting rows in place would show a half-written catalog to the next search.
 */
export const save = (
  skills: ReadonlyMap<SkillID, Skill>,
  meta: Meta,
  directory: string,
): Effect.Effect<void, StoreError> =>
  Effect.gen(function* () {
    const target = paths(directory)
    yield* attempt(() => fs.mkdir(target.directory, { recursive: true })).pipe(failed("create the cache directory"))
    const rows = [...skills.values()].map((skill) => JSON.stringify(skill)).join("\n")
    yield* writeAtomic(target.skills, rows === "" ? "" : `${rows}\n`)
    yield* writeAtomic(
      target.meta,
      `${JSON.stringify({ version: VERSION, updatedAt: meta.updatedAt ?? 0 }, null, 2)}\n`,
    )
  })

const failed = (operation: string) =>
  Effect.mapError((error: unknown) => new StoreError({ message: `${operation}: ${message(error)}` }))

const absent = (error: unknown) => code(error) === "ENOENT"

const code = (error: unknown) =>
  error !== null && typeof error === "object" && "code" in error ? String(error.code) : ""

const safeParse = (raw: string): unknown => {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

const message = (error: unknown) => (error instanceof globalThis.Error ? error.message : String(error))
