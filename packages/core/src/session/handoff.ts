export * as SessionHandoff from "./handoff.js"

import { readFile } from "node:fs/promises"
import { Effect, Schema } from "effect"
import { Flock } from "@orchestra/util/flock"
// Handoff writers are plain functions with no layer, but the lock below needs
// Flock's global (the state directory). Importing Global sets it as a module
// side effect, so the lock never throws "Flock global not set" no matter who
// imports this module first.
import "@orchestra/util/global"
import { ProjectDirs } from "../project-dirs.js"
import { WriteAtomic } from "../write-atomic.js"

// A handoff is what makes a stop cheap: where the session stopped, what works, what does
// not, and the next step — written before any pause, so a resumed session or a replacement
// agent starts from minutes of reading instead of hours of re-discovery.
//
// Layout follows the three-level memory design (L3, session level): the file lives at
// `.orchestra/sessions/<id>/handoff.md` next to the session's own memory. The L3 design
// also asks for `memory.md` in the same folder; that file is not this module's job.
//
// Two writers share this file:
// - the agent itself, ordered by rule (see Rules.DEFAULT_SOCIETY_RULES): it knows what
//   works and what the next step is, so its handoff is the real one;
// - the execution layer, on an interrupted or failed stop (session/execution.ts): it only
//   knows the stop itself, so it writes a *stub* — marked with STUB_MARKER — when no
//   handoff exists yet, and refreshes a stub, but never overwrites an agent-written one.
export class HandoffError extends Schema.TaggedError<HandoffError>()("SessionHandoff.Error", {
  message: Schema.String,
}) {}

export type Reason = "user" | "inactivity" | "shutdown" | "pause" | "failed"

/** A file that starts with this line was written by the execution layer, not by an agent. */
export const STUB_MARKER = "<!-- orchestra-handoff-stub -->"

export interface Input {
  readonly reason: Reason
  /** ISO timestamp; defaults to now. */
  readonly stoppedAt?: string
  readonly works?: string
  readonly broken?: string
  readonly nextStep?: string
  readonly notes?: string
}

export const pathFor = (directory: string, sessionID: string): string =>
  ProjectDirs.resolveWrite(directory, `sessions/${sessionID}/handoff.md`)

export const render = (input: Input): string => {
  const stoppedAt = input.stoppedAt ?? new Date().toISOString()
  const value = (text: string | undefined): string => (text?.trim() ? text.trim() : "(not recorded)")
  return [
    `# Handoff — stopped ${stoppedAt}`,
    "",
    `- Reason: ${input.reason}`,
    "",
    "## What works",
    value(input.works),
    "",
    "## What does not work",
    value(input.broken),
    "",
    "## Next step",
    value(input.nextStep),
    ...(input.notes?.trim() ? ["", "## Notes", input.notes.trim()] : []),
    "",
  ].join("\n")
}

const fail = (message: string) => new HandoffError({ message })

// Both writers share one file, so both run under one lock (A3-16): the
// agent's write and the execution layer's stub used to race — the stub's
// read-then-write could clobber a real handoff written between the two.
// The lock is per file, so different sessions never wait on each other.
const locked = <A>(destination: string, sessionID: string, effect: Effect.Effect<A, HandoffError>) =>
  Effect.scoped(
    Flock.effect(`handoff:${destination}`).pipe(
      Effect.andThen(effect),
      Effect.mapError((cause) =>
        cause instanceof HandoffError
          ? cause
          : fail(`Could not lock the handoff for ${sessionID}: ${String(cause)}`),
      ),
    ),
  )

/** Writes the agent's handoff, replacing whatever was there — including a stub. */
export const write = Effect.fn("SessionHandoff.write")(function* (directory: string, sessionID: string, input: Input) {
  const destination = pathFor(directory, sessionID)
  return yield* locked(
    destination,
    sessionID,
    Effect.tryPromise({
      try: () => WriteAtomic.writeAtomic(destination, render(input)),
      catch: (cause) => fail(`Could not write handoff for ${sessionID}: ${cause instanceof Error ? cause.message : String(cause)}`),
    }),
  )
})

/** Writes a stub when no handoff exists, refreshes an existing stub, and leaves an agent-written handoff alone. Never fails the caller for a missing directory: a stop with nowhere to write is reported, not fatal. */
export const writeStubIfMissing = Effect.fn("SessionHandoff.writeStubIfMissing")(function* (
  directory: string,
  sessionID: string,
  reason: Reason,
) {
  const destination = pathFor(directory, sessionID)
  return yield* locked(
    destination,
    sessionID,
    Effect.gen(function* () {
      const existing = yield* Effect.tryPromise({
        try: async () => {
          try {
            return await readFile(destination, "utf8")
          } catch (cause) {
            if (typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT") return undefined as string | undefined
            throw cause
          }
        },
        catch: (cause) =>
          fail(`Could not read handoff for ${sessionID}: ${cause instanceof Error ? cause.message : String(cause)}`),
      })
      if (existing !== undefined && !existing.startsWith(STUB_MARKER)) return "kept" as const
      const stub: Input = {
        reason,
        works: "(not recorded — the session stopped before writing a handoff)",
        broken: "(not recorded — the session stopped before writing a handoff)",
        nextStep: "Read the session history and the DoD board, then write a real handoff before continuing.",
      }
      yield* Effect.tryPromise({
        try: () => WriteAtomic.writeAtomic(destination, [STUB_MARKER, render(stub)].join("\n")),
        catch: (cause) => fail(`Could not write handoff stub for ${sessionID}: ${cause instanceof Error ? cause.message : String(cause)}`),
      })
      return existing === undefined ? ("created" as const) : ("refreshed" as const)
    }),
  )
})
