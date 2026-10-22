export * as SkillMarketplaceSave from "./save.js"

import { Effect, Schema } from "effect"
import { SkillMarketplaceRead } from "./read.js"
import { SkillMarketplaceStore } from "./store.js"

/**
 * Where a skill kept for good belongs: the same directory the config loader already scans for
 * global skills, so a skill saved here shows up in the `skill` tool with no extra wiring.
 */
export const GLOBAL_DIRECTORY = "skills"

export class SaveError extends Schema.TaggedError<SaveError>()("@orchestra/SkillMarketplace/SaveError", {
  message: Schema.String,
}) {}

export interface Result {
  /** The file written, so the answer can name where the skill now lives. */
  readonly path: string
  /** True when the file was already there and left alone: a repeat is not a new decision. */
  readonly existed: boolean
}

/**
 * Writes one skill into the global registry, and only when a caller asks for it by name.
 *
 * `root` is the directory the config loader already scans for global skills, so a skill saved
 * here turns up in the `skill` tool with no extra wiring.
 *
 * Nothing here decides that a skill should be kept: search, read and apply never call this. It
 * is a separate, explicit step because a global skill outlives the project it was found in and
 * follows the user everywhere, and nothing about a search implies that.
 */
export const save = (root: string, name: string, content: string): Effect.Effect<Result, SaveError> =>
  Effect.gen(function* () {
    const target = SkillMarketplaceRead.appliedPath(root, name)
    if (target === undefined)
      return yield* new SaveError({
        message: `"${name}" is not a usable skill name: letters, digits and dashes only`,
      })
    // `exists` can throw on an unreadable parent; treat that as "not there yet" so the write
    // below produces the real error rather than a guess about the filesystem.
    const existed = yield* Effect.tryPromise({
      try: async () => await Bun.file(target).exists(),
      catch: () => false,
    }).pipe(Effect.result)
    if (existed._tag === "Success" && existed.success) return { path: target, existed: true }
    yield* SkillMarketplaceStore.writeAtomic(target, content.endsWith("\n") ? content : `${content}\n`).pipe(
      Effect.mapError((error) => new SaveError({ message: `the skill could not be saved globally: ${error.message}` })),
    )
    return { path: target, existed: false }
  })
