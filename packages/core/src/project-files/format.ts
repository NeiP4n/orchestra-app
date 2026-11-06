export * as ProjectFilesFormat from "./format.js"

import { appendFile, mkdir, readFile, rename, stat } from "node:fs/promises"
import path from "node:path"
import { Effect, Schema } from "effect"
import { WriteAtomic } from "../write-atomic.js"
import { ProjectFilesErrors } from "./errors.js"

/**
 * One place where project files are parsed and written, so every file in
 * `.orchestra` behaves the same way: a file that does not parse is a loud
 * `ProjectFileError` (kind `corrupt`), never an empty value; a write is
 * atomic (temp file + rename, the previous file survives a crash); a JSONL
 * append never blocks its caller on rotation. YAML goes through
 * `Bun.YAML` (the same parser `Dod` and `Zones` use); JSON goes through
 * `Schema` so an unknown shape is rejected at the boundary that owns it.
 * Plain `node:fs/promises`, like the skill marketplace store — core does
 * not depend on `@effect/platform`.
 */

const isNotFound = (error: unknown): boolean =>
  error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT"

export const exists = (file: string): Effect.Effect<boolean> =>
  Effect.tryPromise({ try: () => stat(file).then(() => true), catch: (error) => error }).pipe(
    Effect.catch(() => Effect.succeed(false)),
  )

export const readText = (file: string): Effect.Effect<string, ProjectFilesErrors.ProjectFileError> =>
  Effect.tryPromise({
    try: () => readFile(file, "utf8"),
    catch: (error) =>
      isNotFound(error)
        ? ProjectFilesErrors.missing(file, `${file} does not exist`)
        : ProjectFilesErrors.missing(file, `cannot read ${file}: ${String(error)}`),
  })

export const writeText = (file: string, contents: string): Effect.Effect<void, ProjectFilesErrors.ProjectFileError> =>
  Effect.tryPromise({
    try: () => WriteAtomic.writeAtomic(file, contents),
    catch: (error) => ProjectFilesErrors.writeFailed(file, `cannot write ${file}: ${String(error)}`),
  })

export const decodeYaml = <A>(file: string, schema: Schema.Codec<A, unknown, never>) =>
  (text: string): Effect.Effect<A, ProjectFilesErrors.ProjectFileError> =>
    Effect.gen(function* () {
      const parsed = yield* Effect.try({
        try: () => Bun.YAML.parse(text),
        catch: (error) => ProjectFilesErrors.corrupt(file, `${file} does not parse as YAML: ${String(error)}`),
      })
      return yield* Schema.decodeUnknownEffect(schema)(parsed).pipe(
        Effect.mapError((error) =>
          ProjectFilesErrors.corrupt(file, `${file} is not a valid ${file.split("/").pop()}: ${error.message}`)
        ),
      )
    })

export const readYaml = <A>(
  file: string,
  schema: Schema.Codec<A, unknown, never>,
): Effect.Effect<A, ProjectFilesErrors.ProjectFileError> => readText(file).pipe(Effect.flatMap(decodeYaml(file, schema)))

export const writeYaml = (file: string, value: unknown): Effect.Effect<void, ProjectFilesErrors.ProjectFileError> =>
  Effect.try({
    try: () => Bun.YAML.stringify(value),
    catch: (error) => ProjectFilesErrors.writeFailed(file, `cannot render ${file} as YAML: ${String(error)}`),
  }).pipe(Effect.flatMap((text) => writeText(file, text)))

export const decodeJson = <A>(file: string, schema: Schema.Codec<A, unknown, never>) =>
  (text: string): Effect.Effect<A, ProjectFilesErrors.ProjectFileError> =>
    Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(text).pipe(
      Effect.mapError((error) =>
        ProjectFilesErrors.corrupt(file, `${file} is not valid JSON or has the wrong shape: ${error.message}`)
      ),
    )

export const readJson = <A>(
  file: string,
  schema: Schema.Codec<A, unknown, never>,
): Effect.Effect<A, ProjectFilesErrors.ProjectFileError> => readText(file).pipe(Effect.flatMap(decodeJson(file, schema)))

export const writeJson = (file: string, value: unknown): Effect.Effect<void, ProjectFilesErrors.ProjectFileError> =>
  writeText(file, `${JSON.stringify(value, null, 2)}\n`)

/** Reads a JSONL file as an array of decoded entries. A missing file is an empty log, not an error. */
export const readJsonl = <A>(
  file: string,
  schema: Schema.Codec<A, unknown, never>,
): Effect.Effect<ReadonlyArray<A>, ProjectFilesErrors.ProjectFileError> =>
  Effect.gen(function* () {
    const text = yield* Effect.tryPromise({ try: () => readFile(file, "utf8"), catch: (error) => error }).pipe(
      Effect.catch((error) =>
        isNotFound(error)
          ? Effect.succeed("")
          : Effect.fail(ProjectFilesErrors.missing(file, `cannot read ${file}: ${String(error)}`))
      ),
    )
    const lines = text.split("\n").filter((line) => line.trim() !== "")
    const entries: Array<A> = []
    for (const [index, line] of lines.entries()) {
      const entry = yield* decodeJson(`${file}:${index + 1}`, schema)(line)
      entries.push(entry)
    }
    return entries
  })

/**
 * Appends one entry to a JSONL log. Best-effort by design (the log never
 * blocks the work it records): a failure to append is swallowed, never
 * thrown. Rotation keeps one older copy at the size cap, the same rule
 * the skill-level journal uses.
 */
export const appendJsonl = (file: string, entry: unknown, options?: { rotateAtBytes?: number }): Effect.Effect<void> =>
  Effect.tryPromise({
    try: async () => {
      const rotateAt = options?.rotateAtBytes ?? 1_048_576
      await mkdir(path.dirname(file), { recursive: true })
      const size = await stat(file)
        .then((info) => info.size)
        .catch(() => 0)
      if (size >= rotateAt) await rename(file, `${file}.1`).catch(() => undefined)
      await appendFile(file, `${JSON.stringify(entry)}\n`, "utf8")
    },
    catch: () => undefined,
  }).pipe(Effect.catch(() => Effect.void))

export const ensureDir = (dir: string): Effect.Effect<void, ProjectFilesErrors.ProjectFileError> =>
  Effect.tryPromise({
    try: () => mkdir(dir, { recursive: true }),
    catch: (error) => ProjectFilesErrors.writeFailed(dir, `cannot create ${dir}: ${String(error)}`),
  })
