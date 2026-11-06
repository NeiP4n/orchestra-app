export * as Sprint from "./sprint.js"

import { readFile, rm } from "node:fs/promises"
import { Effect, Schema } from "effect"
import { ProjectDirs } from "./project-dirs.js"
import { WriteAtomic } from "./write-atomic.js"

// Cold start of a sprint (approach idea #12): the first 30 minutes are reading code and
// asking questions only; writing code is forbidden until the read-only phase ends.
//
// The phase is a marker file, `.orchestra/sprint.json`, so any session of the project can
// read it without a server round-trip, and it survives a restart. Enforcement is split:
// - `checkWrite` is the code check — the orchestrator and any tool that consults it refuse
//   a write tool while the phase is read-only;
// - the rule in Rules.DEFAULT_SOCIETY_RULES is what binds the model itself.
//
// Honest limit: this is NOT a hard gate on every mutating tool. The write tools
// (edit, write, patch, shell) each check Permission on their own path, with no shared
// choke point, so wiring a hard deny into all of them would mean touching every tool.
// Until a shared tool gate exists, a model that ignores both the rule and `checkWrite`
// can still write — the phase marker makes the violation visible (the file says when
// the phase ends), it does not make it impossible.
export class SprintError extends Schema.TaggedError<SprintError>()("Sprint.Error", {
  message: Schema.String,
}) {}

export interface Phase {
  /** Epoch milliseconds the sprint started. */
  readonly startedAt: number
  /** Epoch milliseconds the read-only phase ends. */
  readonly readOnlyUntil: number
  readonly minutes: number
  readonly startedBy: string
}

export const FILE = "sprint.json"

/** Default length of the read-only cold-start phase, in minutes. */
export const READ_ONLY_MINUTES = 30

/** The tools that write code or run commands, and are therefore refused during the read-only phase. */
export const WRITE_TOOLS: ReadonlyArray<string> = ["edit", "write", "patch", "shell"]

export const pathFor = (directory: string): string => ProjectDirs.resolveWrite(directory, FILE)

/** Starts a sprint: opens the read-only phase for `minutes` (default 30). Starting again restarts the phase. */
export const start = Effect.fn("Sprint.start")(function* (
  directory: string,
  input?: { readonly minutes?: number; readonly startedBy?: string },
) {
  const startedAt = Date.now()
  const minutes = input?.minutes ?? READ_ONLY_MINUTES
  const phase: Phase = {
    startedAt,
    readOnlyUntil: startedAt + minutes * 60_000,
    minutes,
    startedBy: input?.startedBy ?? "orchestrator",
  }
  const destination = pathFor(directory)
  yield* Effect.tryPromise({
    // A3-16: atomic — a torn sprint file reads as no phase, silently
    // dropping the read-only window.
    try: () => WriteAtomic.writeAtomic(destination, JSON.stringify(phase)),
    catch: (cause) => new SprintError({ message: `Could not start the sprint: ${cause instanceof Error ? cause.message : String(cause)}` }),
  })
  return phase
})

const isPhase = (value: unknown): value is Phase =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as Partial<Phase>).startedAt === "number" &&
  typeof (value as Partial<Phase>).readOnlyUntil === "number"

/** The current sprint phase, or undefined when no sprint was started or the phase file is corrupt (a corrupt file reads as no phase, never as a stuck one). */
export const read = Effect.fn("Sprint.read")(function* (directory: string) {
  const text = yield* Effect.tryPromise({
    try: async () => {
      try {
        return await readFile(pathFor(directory), "utf8")
      } catch (cause) {
        if (typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT") return undefined as string | undefined
        throw cause
      }
    },
    catch: (cause) => new SprintError({ message: `Could not read the sprint phase: ${cause instanceof Error ? cause.message : String(cause)}` }),
  })
  if (text === undefined) return undefined
  try {
    const parsed: unknown = JSON.parse(text)
    return isPhase(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
})

/** Whether the sprint is still inside its read-only phase. */
export const isReadOnly = Effect.fn("Sprint.isReadOnly")(function* (directory: string, now: number = Date.now()) {
  const phase = yield* read(directory)
  return phase !== undefined && now < phase.readOnlyUntil
})

/** Milliseconds left in the read-only phase, or 0 when there is none. */
export const remainingMs = Effect.fn("Sprint.remainingMs")(function* (directory: string, now: number = Date.now()) {
  const phase = yield* read(directory)
  return phase === undefined ? 0 : Math.max(0, phase.readOnlyUntil - now)
})

/**
 * The refusal message for a write tool during the read-only phase, or undefined when the
 * tool may run. Read tools always pass. Callers that enforce the phase refuse with this
 * text; callers that only report it show it and continue.
 */
export const checkWrite = Effect.fn("Sprint.checkWrite")(function* (
  directory: string,
  tool: string,
  now: number = Date.now(),
) {
  if (!WRITE_TOOLS.includes(tool)) return undefined
  const phase = yield* read(directory)
  if (phase === undefined || now >= phase.readOnlyUntil) return undefined
  const left = Math.ceil((phase.readOnlyUntil - now) / 60_000)
  return `The sprint is in its read-only cold-start phase for ${left} more minute${left === 1 ? "" : "s"}: read code and ask questions; do not call ${tool} yet.`
})

/** Ends the sprint phase early. Removing a phase that was never started is a no-op. */
export const end = Effect.fn("Sprint.end")(function* (directory: string) {
  yield* Effect.tryPromise({
    try: () => rm(pathFor(directory), { force: true }),
    catch: (cause) => new SprintError({ message: `Could not end the sprint: ${cause instanceof Error ? cause.message : String(cause)}` }),
  })
})
