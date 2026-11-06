export * as Contracts from "./contracts.js"

import { mkdir } from "node:fs/promises"
import path from "node:path"
import { Effect, Schema } from "effect"
import { ProjectDirs } from "./project-dirs.js"

export class ContractsError extends Schema.TaggedError<ContractsError>()("Contracts.Error", {
  message: Schema.String,
}) {}

// Module contracts, written before coding (idea #21): the interfaces and data
// formats between modules are fixed here in writing, and nobody changes them
// silently afterwards. A change needs a recorded decision (see the change log
// below; its long form is an ADR in `.orchestra/decisions/` — the format slice C
// settles — and every log entry names that ADR id or `-`).
//
// The gate: implementation work does not start until this document exists and
// is accepted. The gate is opt-in by the file itself — a project without
// contracts.md has no gate — but once the file exists, `Dod.take` refuses new
// work until the status line reads `accepted`.
export const FILE = ProjectDirs.primary("contracts.md")
export const LEGACY_FILE = ProjectDirs.legacy("contracts.md")

export type Status =
  | { exists: false }
  | { exists: true; accepted: boolean; acceptedBy?: string; acceptedAt?: string }

const TEMPLATE = [
  "# Module contracts",
  "",
  "Interfaces and data formats between this project's modules, fixed in writing",
  "before coding. Nobody changes them silently: a change needs a recorded",
  "decision in the change log below (long form: an ADR in",
  "`.orchestra/decisions/`; the log entry names its id or `-`).",
  "",
  "Status: draft",
  "Accepted-by: -",
  "Accepted-at: -",
  "",
  "## Modules",
  "",
  "- <module> — <what it owns, one line>",
  "",
  "## Interfaces",
  "",
  "- <module A> -> <module B>: <function or message, inputs, outputs>",
  "",
  "## Data formats",
  "",
  "- <name>: <shape, version, where it lives>",
  "",
  "## Change log",
  "",
  "- <YYYY-MM-DD> | <what changed> | decided by <name> | reason: <why> | ADR: <id or ->",
  "",
].join("\n")

/** Creates the document from the template when the project has none. */
export const initialize = Effect.fn("Contracts.initialize")(function* (directory: string) {
  const file = ProjectDirs.resolveWrite(directory, "contracts.md")
  const exists = yield* Effect.tryPromise({
    try: () => Bun.file(file).exists(),
    catch: (cause) =>
      new ContractsError({
        message: `Could not read ${file}: ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
  })
  if (exists) return "existing" as const
  yield* Effect.tryPromise({
    try: async () => {
      await mkdir(path.dirname(file), { recursive: true })
      await Bun.write(file, TEMPLATE)
    },
    catch: (cause) =>
      new ContractsError({
        message: `Could not write ${file}: ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
  })
  return "created" as const
})

/** Whether the document exists and whether it has been accepted. */
export const status = Effect.fn("Contracts.status")(function* (directory: string) {
  const file = ProjectDirs.resolveRead(directory, "contracts.md")
  const exists = yield* Effect.tryPromise({
    try: () => Bun.file(file).exists(),
    catch: (cause) =>
      new ContractsError({
        message: `Could not read ${file}: ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
  })
  if (!exists) return { exists: false } as const
  const text = yield* Effect.tryPromise({
    try: () => Bun.file(file).text(),
    catch: (cause) =>
      new ContractsError({
        message: `Could not read ${file}: ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
  })
  const accepted = /^Status:\s*accepted\s*$/m.test(text)
  const acceptedBy = /^Accepted-by:\s*(.+?)\s*$/m.exec(text)?.[1]
  const acceptedAt = /^Accepted-at:\s*(.+?)\s*$/m.exec(text)?.[1]
  return {
    exists: true,
    accepted,
    ...(acceptedBy && acceptedBy !== "-" ? { acceptedBy } : {}),
    ...(acceptedAt && acceptedAt !== "-" ? { acceptedAt } : {}),
  } as const
})

/** Marks the document accepted, by name. Fails when the project has no document. */
export const accept = Effect.fn("Contracts.accept")(function* (directory: string, by: string) {
  const file = ProjectDirs.resolveWrite(directory, "contracts.md")
  const current = yield* status(directory)
  if (!current.exists)
    return yield* new ContractsError({
      message: `This project has no contracts document (${FILE}); create it first`,
    })
  const text = yield* Effect.tryPromise({
    try: () => Bun.file(file).text(),
    catch: (cause) =>
      new ContractsError({
        message: `Could not read ${file}: ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
  })
  const now = new Date().toISOString()
  const byName = by.trim() || "unknown"
  const next = setLine(setLine(text, "Status", "accepted"), "Accepted-by", byName)
  const stamped = setLine(next, "Accepted-at", now)
  yield* Effect.tryPromise({
    try: () => Bun.write(file, stamped),
    catch: (cause) =>
      new ContractsError({
        message: `Could not write ${file}: ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
  })
  return { acceptedBy: byName, acceptedAt: now }
})

// Sets a `Key: value` header line, adding it after the Status line when missing.
function setLine(text: string, key: string, value: string) {
  const pattern = new RegExp(`^${key}:.*$`, "m")
  if (pattern.test(text)) return text.replace(pattern, `${key}: ${value}`)
  return text.replace(/^Status:.*$/m, (line) => `${line}\n${key}: ${value}`)
}

/**
 * Records a contract change in the log. The entry names who decided it, why,
 * and the ADR id (or `-` when the change is too small for a long-form record).
 * Fails when the project has no document.
 */
export const recordChange = Effect.fn("Contracts.recordChange")(function* (
  directory: string,
  input: { summary: string; reason: string; decidedBy: string; adr?: string },
) {
  const file = ProjectDirs.resolveWrite(directory, "contracts.md")
  const current = yield* status(directory)
  if (!current.exists)
    return yield* new ContractsError({
      message: `This project has no contracts document (${FILE}); create it first`,
    })
  const summary = input.summary.trim()
  if (!summary) return yield* new ContractsError({ message: "Say what changed in the contract" })
  const text = yield* Effect.tryPromise({
    try: () => Bun.file(file).text(),
    catch: (cause) =>
      new ContractsError({
        message: `Could not read ${file}: ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
  })
  const entry = `- ${new Date().toISOString().slice(0, 10)} | ${summary} | decided by ${input.decidedBy.trim() || "unknown"} | reason: ${input.reason.trim() || "-"} | ADR: ${input.adr?.trim() || "-"}`
  const next = appendToLog(text, entry)
  yield* Effect.tryPromise({
    try: () => Bun.write(file, next),
    catch: (cause) =>
      new ContractsError({
        message: `Could not write ${file}: ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
  })
  return entry
})

function appendToLog(text: string, entry: string) {
  const heading = /^## Change log\s*$/m
  if (!heading.test(text)) return `${text.endsWith("\n") ? text : `${text}\n`}\n## Change log\n\n${entry}\n`
  const lines = text.split("\n")
  const at = lines.findIndex((line) => heading.test(line))
  const after = lines.slice(at + 1)
  const last = after.reduce((index, line, offset) => (line.trim() !== "" ? offset : index), -1)
  const insertAt = last < 0 ? at + 1 : at + 1 + last + 1
  // A template placeholder line (`- <YYYY-MM-DD> | ...`) is not a real entry.
  const placeholder = lines.findIndex((line, index) => index > at && line.includes("<YYYY-MM-DD>"))
  const cleaned = placeholder >= 0 && insertAt > placeholder ? lines.toSpliced(placeholder, 1) : lines
  const position = placeholder >= 0 && insertAt > placeholder ? insertAt - 1 : insertAt
  return [...cleaned.slice(0, position), entry, ...cleaned.slice(position)].join("\n")
}

/**
 * The gate: implementation work may start only when the contracts document
 * exists and is accepted — or when the project has no document at all, in
 * which case there is nothing to gate on. Fails with a message naming the fix.
 */
export const requireAccepted = Effect.fn("Contracts.requireAccepted")(function* (directory: string) {
  const current = yield* status(directory)
  if (!current.exists) return
  if (!current.accepted)
    return yield* new ContractsError({
      message:
        `The project's module contracts (${FILE}) exist but are not accepted yet: ` +
        `implementation work cannot start until they are accepted (dod contracts_accept)`,
    })
})
