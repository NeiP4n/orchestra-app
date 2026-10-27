export * as SkillMarketplaceRead from "./read.js"

import { Duration, Effect, Schema } from "effect"
import { SkillMarketplaceStore } from "./store.js"
import { ProjectDirs } from "../project-dirs.js"

/** `raw.githubusercontent.com` serves the same file the tree URL shows, without the HTML around it. */
export const RAW_ORIGIN = "https://raw.githubusercontent.com"
/** The file every skill directory holds. */
export const FILE = "SKILL.md"
/** The retired proxy truncated here, and the model pays for every character of it. */
export const MAX_CHARACTERS = 20_000
export const TIMEOUT = Duration.seconds(30)

/** Where an applied skill lands inside a project; the existing loader already scans this. */
export const PROJECT_DIRECTORY = ProjectDirs.primary("skills")
export const LEGACY_PROJECT_DIRECTORY = ProjectDirs.legacy("skills")

export interface Text {
  readonly url: string
  readonly content: string
  readonly truncated: boolean
}

export class ReadError extends Schema.TaggedError<ReadError>()("@orchestra/SkillMarketplace/ReadError", {
  message: Schema.String,
  status: Schema.Number.pipe(Schema.optional),
}) {}

export interface Options {
  readonly fetch?: typeof globalThis.fetch
  readonly timeout?: Duration.Duration
  readonly maxCharacters?: number
}

/**
 * The raw URL of a skill's `SKILL.md`, or `undefined` when the GitHub URL is not a tree or blob
 * link. Every one of the 924 rows in the retired cache had the `/tree/<branch>/<path>` shape, so
 * the branch is known and no API call is needed to learn it.
 */
export const rawUrl = (githubUrl: string): string | undefined => {
  const [owner, repo, kind, branch, ...rest] = githubUrl.replace("https://github.com/", "").split("/")
  if (owner === undefined || owner === "" || repo === undefined || repo === "" || branch === undefined || branch === "")
    return undefined
  if (kind !== "tree" && kind !== "blob") return undefined
  const rest_ = rest.join("/")
  // A URL that already points at the file names the directory, not the file.
  const directory = rest_.endsWith(FILE) ? rest_.slice(0, -FILE.length - 1) : rest_
  const root = [RAW_ORIGIN, owner, repo, branch].join("/")
  return directory === "" ? `${root}/${FILE}` : `${root}/${directory}/${FILE}`
}

/**
 * Fetches the skill's own text over one direct link.
 *
 * The catalog has no endpoint for it — it is GitHub that holds the file — so this is the one
 * read that reaches the network, and it happens only when the agent has decided it needs this
 * skill's text. Once applied into the project the file is local and this is not called again.
 */
export const read = (githubUrl: string, options: Options = {}): Effect.Effect<Text, ReadError> =>
  Effect.gen(function* () {
    const target = rawUrl(githubUrl)
    if (target === undefined) return yield* new ReadError({ message: `${githubUrl} is not a GitHub tree or blob link` })
    const body = yield* Effect.tryPromise({
      try: async (signal) => {
        const response = await (options.fetch ?? globalThis.fetch)(target, {
          headers: { "User-Agent": SkillMarketplaceStore.USER_AGENT, accept: "text/plain" },
          signal,
        })
        if (!response.ok)
          throw new ReadError({ message: `GitHub answered ${response.status}`, status: response.status })
        return response.text()
      },
      catch: (error) =>
        error instanceof ReadError
          ? error
          : new ReadError({ message: `the skill text could not be fetched: ${text(error)}` }),
    }).pipe(
      Effect.timeoutOrElse({
        duration: options.timeout ?? TIMEOUT,
        orElse: () => Effect.fail(new ReadError({ message: "GitHub did not answer in time" })),
      }),
    )
    const limit = options.maxCharacters ?? MAX_CHARACTERS
    const clipped = body.length > limit
    return { url: target, content: clipped ? body.slice(0, limit) : body, truncated: clipped }
  })

/**
 * The path a skill occupies under a directory of skill folders, or `undefined` when the catalog
 * name is not a single safe path segment. Catalog names are kebab-case slugs, but nothing about
 * the wire promises that, and a name like `../../etc` must not become a path.
 */
export const appliedPath = (root: string, name: string) =>
  safeSegment(name) === false ? undefined : `${root}/${name}/${FILE}`

/**
 * Writes the text under a directory of skill folders the project's loader already scans, so the
 * next read of this skill is answered from disk. The write is atomic for the same reason the
 * cache's is: a partial file would be discovered as a skill with a truncated body.
 */
export const apply = (root: string, name: string, content: string): Effect.Effect<string, ReadError> =>
  Effect.gen(function* () {
    const target = appliedPath(root, name)
    if (target === undefined)
      return yield* new ReadError({ message: `"${name}" is not a usable skill name: letters, digits and dashes only` })
    yield* SkillMarketplaceStore.writeAtomic(target, content.endsWith("\n") ? content : `${content}\n`).pipe(
      Effect.mapError(
        (error) => new ReadError({ message: `the skill could not be saved into the project: ${error.message}` }),
      ),
    )
    return target
  })

/** A path segment with nothing in it that could climb out of the directory. */
export const safeSegment = (name: string) => /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(name) && !name.includes("..")

const text = (error: unknown) => (error instanceof globalThis.Error ? error.message : String(error))
