export * as Adr from "./adr.js"

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { Effect, Schema } from "effect"
import { ProjectDirs } from "./project-dirs.js"

// Architecture Decision Records: one short file per big decision, all in one place
// (`.orchestra/decisions/adr-NNNN.md`) with search, so a later session — or a new agent —
// learns why a choice was made instead of re-litigating it.
//
// This module defines the layout. The .orchestra-files block (B16) has not landed yet;
// when it does, it must adopt this directory and format rather than invent a second one.
// The orchestrator's standing prompt already points here (plugin/agent.ts: ADR bullet);
// the rule in Rules.DEFAULT_SOCIETY_RULES is what makes writing one mandatory.
export class AdrError extends Schema.TaggedError<AdrError>()("Adr.Error", {
  message: Schema.String,
}) {}

export type Status = "proposed" | "accepted" | "rejected" | "superseded"

export interface Alternative {
  /** An option that was considered and turned down. */
  readonly option: string
  /** Why it lost. */
  readonly rejectedBecause: string
}

export interface Record {
  readonly number: number
  readonly title: string
  readonly status: Status
  /** ISO date (YYYY-MM-DD) the record was written. */
  readonly date: string
  /** The situation that forced a decision. */
  readonly context: string
  /** What was decided. */
  readonly decision: string
  readonly alternatives: ReadonlyArray<Alternative>
  /** What follows from the decision, good and bad. */
  readonly consequences: string
}

export interface CreateInput {
  readonly title: string
  readonly context: string
  readonly decision: string
  readonly alternatives?: ReadonlyArray<Alternative>
  readonly consequences?: string
  readonly status?: Status
}

export const DIR = "decisions"

export const fileName = (number: number): string => `adr-${String(number).padStart(4, "0")}.md`

export const pathFor = (directory: string, number: number): string =>
  ProjectDirs.resolveWrite(directory, `${DIR}/${fileName(number)}`)

export const render = (record: Record): string =>
  [
    `# ADR-${String(record.number).padStart(4, "0")}: ${record.title}`,
    "",
    `- Status: ${record.status}`,
    `- Date: ${record.date}`,
    "",
    "## Context",
    record.context,
    "",
    "## Decision",
    record.decision,
    "",
    "## Alternatives considered",
    ...(record.alternatives.length === 0
      ? ["(none recorded)"]
      : record.alternatives.map((alternative) => `- ${alternative.option} — rejected because ${alternative.rejectedBecause}`)),
    "",
    "## Consequences",
    record.consequences,
    "",
  ].join("\n")

/** Parses a file written by `render`. Returns undefined for anything else — a foreign markdown file in the same directory is not an ADR. */
export const parse = (text: string): Record | undefined => {
  const title = /^# ADR-(\d+): (.+)$/m.exec(text)
  if (!title) return undefined
  const status = /^- Status: (proposed|accepted|rejected|superseded)$/m.exec(text)?.[1] as Status | undefined
  const date = /^- Date: (\d{4}-\d{2}-\d{2})$/m.exec(text)?.[1]
  const section = (heading: string): string => {
    const start = text.indexOf(`## ${heading}\n`)
    if (start < 0) return ""
    const body = text.slice(start + `## ${heading}\n`.length)
    const next = body.indexOf("\n## ")
    return (next < 0 ? body : body.slice(0, next)).trim()
  }
  const alternatives = section("Alternatives considered")
    .split("\n")
    .map((line) => /^- (.+) — rejected because (.+)$/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => ({ option: match[1], rejectedBecause: match[2] }))
  return {
    number: Number(title[1]),
    title: title[2].trim(),
    status: status ?? "proposed",
    date: date ?? "",
    context: section("Context"),
    decision: section("Decision"),
    alternatives,
    consequences: section("Consequences"),
  }
}

const fail = (message: string) => new AdrError({ message })

/** Creates the next ADR in the project's decisions directory and returns it. Numbers are assigned from the files already there, so two writers cannot silently share one. */
export const create = Effect.fn("Adr.create")(function* (directory: string, input: CreateInput) {
  const dir = ProjectDirs.resolveWrite(directory, DIR)
  const records = yield* list(directory)
  const number = records.reduce((max, record) => Math.max(max, record.number), 0) + 1
  const record: Record = {
    number,
    title: input.title.trim(),
    status: input.status ?? "accepted",
    date: new Date().toISOString().slice(0, 10),
    context: input.context.trim(),
    decision: input.decision.trim(),
    alternatives: input.alternatives ?? [],
    consequences: (input.consequences ?? "").trim(),
  }
  if (!record.title || !record.context || !record.decision)
    return yield* fail("An ADR needs a title, context and decision; an empty one records nothing.")
  yield* Effect.tryPromise({
    try: async () => {
      await mkdir(dir, { recursive: true })
      await writeFile(path.join(dir, fileName(number)), render(record), "utf8")
    },
    catch: (cause) => fail(`Could not write ${fileName(number)}: ${cause instanceof Error ? cause.message : String(cause)}`),
  })
  return record
})

const isNotFound = (cause: unknown): boolean =>
  typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT"

/** Every ADR in the project's decisions directory, in number order. Files that do not parse as ADRs are skipped, never fatal: a stray note must not hide the real records. */
export const list = Effect.fn("Adr.list")(function* (directory: string) {
  const dir = ProjectDirs.resolveWrite(directory, DIR)
  const names = yield* Effect.tryPromise({
    try: async () => {
      try {
        return await readdir(dir)
      } catch (cause) {
        if (isNotFound(cause)) return [] as Array<string>
        throw cause
      }
    },
    catch: (cause) => fail(`Could not list ${DIR}/: ${cause instanceof Error ? cause.message : String(cause)}`),
  })
  const records: Array<Record> = []
  for (const name of names.filter((entry) => /^adr-\d+\.md$/.test(entry)).sort()) {
    const text = yield* Effect.tryPromise({
      try: () => readFile(path.join(dir, name), "utf8"),
      catch: (cause) => fail(`Could not read ${name}: ${cause instanceof Error ? cause.message : String(cause)}`),
    })
    const record = parse(text)
    if (record) records.push(record)
  }
  return records.sort((a, b) => a.number - b.number)
})

/** One ADR by number, or undefined when the project has no such record. */
export const read = Effect.fn("Adr.read")(function* (directory: string, number: number) {
  const text = yield* Effect.tryPromise({
    try: async () => {
      try {
        return await readFile(pathFor(directory, number), "utf8")
      } catch (cause) {
        if (isNotFound(cause)) return undefined as string | undefined
        throw cause
      }
    },
    catch: (cause) => fail(`Could not read ${fileName(number)}: ${cause instanceof Error ? cause.message : String(cause)}`),
  })
  return text === undefined ? undefined : parse(text)
})

/** Case-insensitive substring search over title, context, decision and consequences. */
export const search = Effect.fn("Adr.search")(function* (directory: string, query: string) {
  const needle = query.trim().toLowerCase()
  if (!needle) return [] as ReadonlyArray<Record>
  const records = yield* list(directory)
  return records.filter((record) =>
    [record.title, record.context, record.decision, record.consequences, ...record.alternatives.map((item) => item.option)]
      .join("\n")
      .toLowerCase()
      .includes(needle),
  )
})
