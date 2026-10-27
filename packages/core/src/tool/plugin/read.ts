export * as ReadTool from "./read.js"

import type { Context } from "@orchestra/plugin/effect/plugin"
import { basename, dirname, join, relative, resolve } from "path"
import { ToolFailure } from "@orchestra/ai"
import type { Tool } from "@orchestra/schema/tool"
import { Effect, Schema } from "effect"
import { FSUtil } from "@orchestra/util/fs-util"
import { Location } from "../../location.js"
import { FileAccess } from "../../file-access.js"
import { SessionInstructions } from "../../session/instructions.js"
import { AbsolutePath } from "../../schema.js"
import { ReadToolFileSystem } from "../read-filesystem.js"
import { Environment } from "../../environment/index.js"
import { Room } from "../../room.js"
import { Session } from "../../session.js"
import { RoomRules } from "@orchestra/schema/room-rules"
import { Orchestra } from "../../orchestra.js"

export const name = "read"
const FILENAME = "AGENTS.md"
export const MAX_BATCH_FILES = 16
const PageFields = {
  offset: ReadToolFileSystem.PageInput.fields.offset.annotate({
    description: "The line or directory entry to start reading from (1-based)",
  }),
  limit: ReadToolFileSystem.PageInput.fields.limit.annotate({
    description: "The maximum number of lines or directory entries to read (defaults to and capped at 2000)",
  }),
}
const FileInput = Schema.Struct({
  path: Schema.String.annotate({ description: "File or directory to read" }),
  ...PageFields,
})
const LocationInput = Schema.Struct({
  path: Schema.optionalKey(Schema.String.annotate({ description: "File or directory to read" })),
  files: Schema.optionalKey(
    Schema.Array(Schema.Union([Schema.String, FileInput])).annotate({
      description:
        "Read several files or directories in one call instead of one call per path. Entries are read concurrently and share the output budget; an entry may be a path string or { path, offset?, limit? }.",
    }),
  ),
  ...PageFields,
})
export const Input = LocationInput
const Output = Schema.Union([
  ReadToolFileSystem.FileContent,
  ReadToolFileSystem.TextPage,
  ReadToolFileSystem.ListPage,
  ReadToolFileSystem.BatchPage,
])

export const Plugin = {
  id: "orchestra.tool.read",
  effect: Effect.fn("ReadTool.Plugin")(function* (ctx: Context) {
    const reader = yield* ReadToolFileSystem.Service
    const access = yield* FileAccess.Service
    const sessionInstructions = yield* SessionInstructions.Service
    const fs = yield* FSUtil.Service
    const location = yield* Location.Service
    const rooms = yield* Room.Service
    const sessions = yield* Session.Service
    const rulesOf = Effect.fnUntraced(function* (sessionID: Session.ID) {
      const lineage = new Set<string>()
      let session = yield* sessions.get(sessionID).pipe(Effect.orElseSucceed(() => undefined))
      while (session && !lineage.has(session.id)) {
        lineage.add(session.id)
        if (!session.parentID) break
        const parent = yield* sessions.get(session.parentID).pipe(Effect.orElseSucceed(() => undefined))
        if (!parent) break
        session = parent
      }
      if (!session) return undefined
      const directory = session.location.directory
      return RoomRules.merge(
        (yield* rooms.list()).flatMap((room) =>
          lineage.has(room.sessionID) || (room.directory && Orchestra.contains(room.directory, directory))
            ? [room.rules ?? {}]
            : [],
        ),
      )
    })

    yield* ctx.tool
      .transform((editor) =>
        editor.add({
          name,
          options: { codemode: false, core: true },
          description:
            "Read the contents of a file or directory. Supports text files, images, and PDFs. Images and PDFs are presented directly to the model. Each text line is prefixed by its 1-based line number as <line>: <content>. The prefix is for reference and is not part of the file content. Directory entries are returned one per line. Pass files: [{ path }, ...] to read several paths in one call: they are read concurrently, share one output budget, and one missing or unreadable path does not discard the others. Use offset and limit to read large files or directories in sections. Prefer one larger read or one files batch over many small calls, and use grep to find specific content in large files.",
          input: Input,
          output: Output,
          execute: (input, context) => {
            return Effect.gen(function* () {
              const requests = yield* requestsOf(input)
              // The output shape follows the input shape: a `files` request always settles as a batch,
              // even with one entry, so a caller never has to branch on the result type.
              const batch = input.files !== undefined
              const lineBudget = Math.max(1, Math.floor(ReadToolFileSystem.MAX_READ_LINES / requests.length))
              const byteBudget = Math.max(1, Math.floor(ReadToolFileSystem.MAX_READ_BYTES / requests.length))
              // A batch is for breadth: every entry gets an even share of the one tool-output
              // budget, so a per-file limit cannot inflate the whole result past the cap.
              const pageOf = (request: Request): ReadToolFileSystem.ReadPage =>
                batch
                  ? {
                      offset: request.offset ?? input.offset,
                      limit: Math.min(request.limit ?? input.limit ?? lineBudget, lineBudget),
                      maxBytes: byteBudget,
                    }
                  : { offset: request.offset, limit: request.limit }

              const rules = yield* rulesOf(context.sessionID)
              const targets = yield* (batch
                ? access.authorizeReadMany(
                    requests.map((request) => request.path),
                    context,
                  )
                : access.authorizeRead(requests[0].path, context).pipe(Effect.map((target) => [target])))

              const recover = (
                request: Request,
                target: FileAccess.Target,
                page: ReadToolFileSystem.ReadPage,
              ): Effect.Effect<Settled, unknown> =>
                Effect.gen(function* () {
                  const alternate = yield* alternatePath(target.absolute).pipe(Effect.orElseSucceed(() => undefined))
                  if (!alternate) return yield* missing(request.path, target.absolute, rules)
                  const next = yield* access.authorizeRead(alternate, context, { siblingOf: target })
                  const content = yield* reader.read(next.absolute, next.resource, page).pipe(
                    Effect.catchIf(
                      (error) => error instanceof Environment.NotFound,
                      () => missing(request.path, target.absolute, rules),
                    ),
                  )
                  if (content.type === "list-page") return yield* missing(request.path, target.absolute)
                  return {
                    content,
                    target: next,
                    path: join(dirname(request.path), basename(alternate)),
                  }
                })

              const read = (request: Request, target: FileAccess.Target): Effect.Effect<Settled, unknown> => {
                const page = pageOf(request)
                return reader.read(target.absolute, target.resource, page).pipe(
                  Effect.map((content) => ({ content, target, path: request.path })),
                  Effect.catchIf(
                    (error) => error instanceof Environment.NotFound,
                    () => recover(request, target, page),
                  ),
                )
              }

              // One unreachable path in a batch becomes a per-entry error so the remaining
              // files still reach the model. A single path keeps the strict tool failure.
              const settled: ReadonlyArray<Settled> = batch
                ? yield* Effect.forEach(
                    requests,
                    (request, index) =>
                      read(request, targets[index]).pipe(
                        Effect.catchIf(
                          (error): error is InlineError => inlineable(error),
                          (error) =>
                            Effect.succeed({
                              content: { type: "error" as const, message: error.message },
                              target: targets[index],
                              path: request.path,
                            }),
                        ),
                      ),
                    { concurrency: "unbounded" },
                  )
                : [yield* read(requests[0], targets[0])]

              for (const result of settled) {
                if (result.content.type !== "list-page") continue
                const entries = result.content.entries.filter((entry) => {
                  const file = relative(location.directory, resolve(result.target.absolute, entry.path)).replaceAll("\\", "/")
                  return !rules || !RoomRules.protectedFile(rules, file)
                })
                result.content = new ReadToolFileSystem.ListPage({
                  ...result.content,
                  entries,
                })
              }

              yield* Effect.gen(function* () {
                const starts = new Set<string>()
                const readFiles = new Set<string>()
                for (const result of settled) {
                  if (result.target.externalDirectory !== undefined) continue
                  const resolved = yield* fs.resolve(result.target.absolute)
                  readFiles.add(resolved)
                  starts.add(result.content.type === "list-page" ? resolved : dirname(resolved))
                }
                if (starts.size === 0) return
                const root = yield* fs.resolve(location.directory)
                const candidates = new Set<string>()
                for (const start of starts) {
                  const discovered = yield* fs.up({
                    targets: [FILENAME],
                    start,
                    stop: root,
                    type: "file",
                  })
                  for (const file of yield* Effect.forEach(discovered, fs.resolve)) {
                    if (FSUtil.contains(dirname(file), root) || readFiles.has(file)) continue
                    candidates.add(file)
                  }
                }
                if (candidates.size === 0) return
                yield* sessionInstructions.load({ sessionID: context.sessionID, paths: [...candidates] })
              }).pipe(
                Effect.catch(() => Effect.void),
                Effect.catchDefect(() => Effect.void),
              )

              for (const result of settled) {
                const content = result.content
                if (
                  content.type !== "file" ||
                  content.encoding !== "base64" ||
                  ReadToolFileSystem.MEDIA_MIMES.has(content.mime)
                )
                  continue
                if (!batch)
                  return yield* Effect.fail(new ReadToolFileSystem.BinaryFileError({ resource: result.target.resource }))
                result.content = {
                  type: "error",
                  message: `Cannot read binary file: ${result.target.resource}`,
                }
              }

              if (!batch) {
                const content = settled[0].content
                if (content.type === "error")
                  return yield* Effect.die(new Error("Single read settled as an inline error"))
                return { output: content, path: settled[0].path }
              }
              return {
                output: new ReadToolFileSystem.BatchPage({
                  type: "batch",
                  entries: settled.map((result) => ({ path: result.path, result: result.content })),
                  truncated: settled.some(
                    (result) =>
                      (result.content.type === "text-page" || result.content.type === "list-page") &&
                      result.content.truncated,
                  ),
                }),
                path: requests.map((request) => request.path).join(", "),
              }
            }).pipe(
              Effect.map((result) => ({
                output: result.output,
                content: toModelContent(result.path, input.offset, result.output),
                metadata: {
                  truncated:
                    result.output.type === "batch"
                      ? result.output.truncated
                      : result.output.type === "file"
                        ? false
                        : result.output.truncated,
                },
              })),
              Effect.mapError((error) => {
                if (error instanceof ToolFailure) return error
                const cause = error instanceof Error ? `: ${error.message}` : error ? `: ${String(error)}` : ""
                const message =
                  error instanceof ReadToolFileSystem.BinaryFileError ||
                  error instanceof ReadToolFileSystem.MediaIngestLimitError ||
                  error instanceof ReadToolFileSystem.OffsetOutOfRangeError ||
                  error instanceof ReadToolFileSystem.PathKindError
                    ? error.message
                    : `Unable to read ${
                        input.path ??
                        input.files?.map((file) => (typeof file === "string" ? file : file.path)).join(", ") ??
                        "path"
                      }${cause}`
                return new ToolFailure({ message, error })
              }),
            )
          },
        }),
      )
      .pipe(Effect.orDie)

    const alternatePath = Effect.fn("ReadTool.alternatePath")(function* (absolute: string) {
      const canonical = (name: string) =>
        name
          .normalize("NFC")
          .replace(/[\u00a0\u202f]/g, " ")
          .replace(/[\u2018\u2019]/g, "'")
      const base = canonical(basename(absolute))
      const matches = (yield* reader.list(AbsolutePath.make(dirname(absolute)))).filter(
        (entry) => entry.type === "file" && canonical(entry.name) === base,
      )
      if (matches.length !== 1) return
      return join(dirname(absolute), matches[0].name)
    })

    const missing = Effect.fn("ReadTool.missing")(function* (
      input: string,
      absolute: string,
      rules?: RoomRules.Rules,
    ) {
      const base = basename(input).toLowerCase()
      const suggestions = yield* fs.readDirectory(dirname(absolute)).pipe(
        Effect.map((entries) =>
          entries
            .filter((entry) => {
              const candidate = entry.toLowerCase()
              if (rules && RoomRules.protectedFile(rules, relative(location.directory, resolve(dirname(absolute), entry)))) return false
              return candidate.includes(base) || base.includes(candidate)
            })
            .map((entry) => join(dirname(input), entry))
            .slice(0, 3),
        ),
        Effect.orElseSucceed(() => [] as string[]),
      )
      const message =
        suggestions.length === 0
          ? `File not found: ${input}`
          : `File not found: ${input}\n\nDid you mean one of these?\n${suggestions.join("\n")}`
      return yield* new ToolFailure({ message })
    })
  }),
}

type Request = { readonly path: string; readonly offset?: number; readonly limit?: number }

type Settled = {
  content: ReadToolFileSystem.FileContent | ReadToolFileSystem.TextPage | ReadToolFileSystem.ListPage | ReadToolFileSystem.BatchFailure
  target: FileAccess.Target
  path: string
}

/** Read failures a batch reports per entry instead of failing the whole call. */
type InlineError =
  | ToolFailure
  | ReadToolFileSystem.BinaryFileError
  | ReadToolFileSystem.MediaIngestLimitError
  | ReadToolFileSystem.OffsetOutOfRangeError
  | ReadToolFileSystem.PathKindError

const inlineable = (error: unknown): error is InlineError =>
  error instanceof ToolFailure ||
  error instanceof ReadToolFileSystem.BinaryFileError ||
  error instanceof ReadToolFileSystem.MediaIngestLimitError ||
  error instanceof ReadToolFileSystem.OffsetOutOfRangeError ||
  error instanceof ReadToolFileSystem.PathKindError

const requestsOf = (input: typeof Input.Type): Effect.Effect<readonly Request[], ToolFailure> =>
  Effect.gen(function* () {
    if (input.path !== undefined && input.files !== undefined)
      return yield* new ToolFailure({ message: "Provide either path or files, not both." })
    if (input.files !== undefined) {
      if (input.files.length === 0)
        return yield* new ToolFailure({ message: "files must contain at least one path." })
      if (input.files.length > MAX_BATCH_FILES)
        return yield* new ToolFailure({
          message: `Read at most ${MAX_BATCH_FILES} paths per call; send the remaining paths in another call.`,
        })
      return input.files.map((file) => (typeof file === "string" ? { path: file } : file))
    }
    if (input.path === undefined) return yield* new ToolFailure({ message: "Provide path or files." })
    return [{ path: input.path, offset: input.offset, limit: input.limit }]
  })

export const toModelContent = (
  path: string,
  offset: number | undefined,
  output: typeof Output.Type,
): string | ReadonlyArray<Tool.Content> => {
  if (output.type === "batch") {
    return output.entries.flatMap((entry) => {
      if (entry.result.type === "error")
        return [{ type: "text" as const, text: `Cannot read ${entry.path}: ${entry.result.message}` }]
      const content = toModelContent(entry.path, undefined, entry.result)
      return typeof content === "string" ? [{ type: "text" as const, text: content }] : content
    })
  }

  if (output.type === "file" && output.encoding === "base64")
    return [
      { type: "text", text: output.mime === "application/pdf" ? "PDF read successfully" : "Image read successfully" },
      {
        type: "file",
        uri: `data:${output.mime};base64,${output.content}`,
        mime: output.mime,
        name: path,
      },
    ] as const

  if (output.type === "list-page") {
    const start = offset || 1
    const content = [
      output.entries.length === 0
        ? `Read directory ${path}, 0 entries`
        : `Read directory ${path}, entries ${start}-${start + output.entries.length - 1}`,
    ]
    output.entries.forEach((entry) => content.push(entry.path))
    if (output.truncated && output.next !== undefined)
      content.push(`[Output truncated. Continue reading with offset: ${output.next}]`)
    return content.join("\n")
  }

  const start = output.type === "text-page" ? output.offset : 1
  const text = output.type === "file" ? output.content.replace(/\n$/, "") : output.content
  const lines = output.content === "" ? [] : text.split("\n")
  const content = [
    lines.length === 0 ? `Read file ${path}, 0 lines` : `Read file ${path}, lines ${start}-${start + lines.length - 1}`,
  ]
  lines.forEach((line, index) => content.push(`${start + index}: ${line}`))
  if (output.type === "text-page" && output.truncated && output.next !== undefined)
    content.push(`[Output truncated. Continue reading with offset: ${output.next}]`)
  return content.join("\n")
}
