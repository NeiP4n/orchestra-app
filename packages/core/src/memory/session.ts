export * as SessionMemory from "./session.js"

import { appendFile, mkdir } from "node:fs/promises"
import { readFileSync } from "node:fs"
import path from "node:path"
import { Cause, Effect, Schema } from "effect"
import { Flock } from "@orchestra/util/flock"
// The lock below needs Flock's global (the state directory). Importing Global
// sets it as a module side effect, so the lock never throws "Flock global not
// set" no matter who imports this module first (same pattern as handoff.ts).
import "@orchestra/util/global"
import { Instructions } from "../instructions/index.js"
import { ProjectDirs } from "../project-dirs.js"
import { SessionHandoff } from "../session/handoff.js"
import { ModelRouter } from "../session/model-router.js"
import { WriteAtomic } from "../write-atomic.js"
import { MemoryEngine } from "./engine.js"

/**
 * L3 — session memory (Б17, approved design §1/§8 steps 3–6).
 *
 * One session folder, `.orchestra/sessions/<id>/`, holds:
 * - `memory.md` — the session's own summary, ≤ 8 KiB, decisions and lessons first;
 * - `handoff.md` — mandatory on stop (written by SessionHandoff, reused here, never overwritten);
 * - `journal.jsonl` — raw tool-use records, the facts (the journal is facts, memory is conclusions);
 * - `scratch.md` — detail that did not fit the 8 KiB memory.md;
 * - `state.json` — idempotency + checkpoint bookkeeping.
 *
 * All L3 writes go through the single write point `captureToolUse` /
 * `finalizeSession` below. Secrets: the live call site
 * (`session/runner/llm.ts`) passes the foundation scrubber
 * (`memory/scrub.ts`, `scrubText`); `captureToolUse` accepts an optional
 * `scrub` override for tests, defaulting to identity there. Do NOT write a
 * second scrubber here.
 */

export class SessionMemoryError extends Schema.TaggedError<SessionMemoryError>()("SessionMemory.Error", {
  message: Schema.String,
}) {}

/** Hard cap for `memory.md`, in UTF-8 bytes (design §1). */
export const MEMORY_MAX_BYTES = 8_192
/** Start-of-session injection budget, in characters (design §1). */
export const START_BUDGET_CHARS = 12_000
/** Raw tool I/O is cut at 64 KiB with a `…[truncated: N bytes]` marker (claude-mem `tool_uses`). */
export const TOOL_IO_MAX_BYTES = 65_536
/** A session is worth summarizing once it kept at least one observation. */
export const MIN_OBSERVATIONS_FOR_SUMMARY = 1

export type ObservationType = "decision" | "bugfix" | "feature" | "refactor" | "discovery" | "change"

export interface SessionObservation {
  readonly sessionID: string
  readonly toolUseID: string
  readonly tool: string
  readonly type: ObservationType
  readonly title: string
  readonly text: string
  readonly failed: boolean
  readonly createdAt: number
}

export interface SessionState {
  readonly version: 1
  readonly sessionID: string
  /** Tool-use ids already recorded: the idempotency key is (session + tool call). */
  readonly recordedToolUseIDs: ReadonlyArray<string>
  readonly observations: number
  readonly lastFinalizedAt?: number
  readonly checkpoint?: { readonly memory: boolean; readonly handoff: boolean; readonly at: number }
}

export interface Checkpoint {
  readonly memory: boolean
  readonly handoff: boolean
  /** The snapshotted memory.md text, for re-inject after compaction. */
  readonly summary?: string
  readonly at: number
}

export const emptyCheckpoint = (): Checkpoint => ({ memory: false, handoff: false, at: Date.now() })

export interface SessionPaths {
  readonly dir: string
  readonly memory: string
  readonly handoff: string
  readonly journal: string
  readonly scratch: string
  readonly state: string
  readonly checkpointDir: string
  readonly checkpointMemory: string
  readonly checkpointHandoff: string
}

export const pathsFor = (directory: string, sessionID: string): SessionPaths => {
  const dir = ProjectDirs.resolveWrite(directory, `sessions/${sessionID}`)
  return {
    dir,
    memory: path.join(dir, "memory.md"),
    handoff: SessionHandoff.pathFor(directory, sessionID),
    journal: path.join(dir, "journal.jsonl"),
    scratch: path.join(dir, "scratch.md"),
    state: path.join(dir, "state.json"),
    checkpointDir: path.join(dir, "checkpoint"),
    checkpointMemory: path.join(dir, "checkpoint", "memory.md"),
    checkpointHandoff: path.join(dir, "checkpoint", "handoff.md"),
  }
}

const fail = (message: string) => new SessionMemoryError({ message })

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export const byteLength = (text: string): number => new TextEncoder().encode(text).length

/**
 * Cuts raw tool I/O at `limit` bytes, keeping the head and marking how much was dropped.
 * Byte-based (not char-based) so the cap holds for multibyte text.
 */
export function truncateToolIO(text: string, limit: number = TOOL_IO_MAX_BYTES): string {
  const bytes = new TextEncoder().encode(text)
  if (bytes.length <= limit) return text
  const marker = `\n…[truncated: ${bytes.length} bytes]`
  const markerBytes = byteLength(marker)
  const keep = Math.max(0, limit - markerBytes)
  const head = new TextDecoder().decode(bytes.subarray(0, keep))
  return `${head}${marker}`
}

/** Write tools: their calls change the world, so they are worth remembering. */
const WRITE_TOOLS = new Set(["edit", "write", "patch", "apply_patch", "shell", "bash", "subagent", "task", "dod"])

const includesAny = (text: string, patterns: ReadonlyArray<RegExp>): boolean =>
  patterns.some((pattern) => pattern.test(text))

/** Classifies one tool call into the claude-mem observation vocabulary. */
export function classifyObservation(
  tool: string,
  inputText: string,
  outputText: string,
  failed: boolean,
): ObservationType {
  const haystack = `${tool}\n${inputText}\n${outputText}`.toLowerCase()
  if (includesAny(haystack, [/решен/, /decid/, /decis/, /выбрал/, /выбор/, /\bchose\b/])) return "decision"
  if (
    failed ||
    includesAny(haystack, [/исправ/, /\bfix/, /почин/, /баг/, /\bbug\b/, /ошибк/, /\berror\b/, /сломан/])
  ) {
    if (WRITE_TOOLS.has(tool) || failed) return "bugfix"
  }
  if (includesAny(haystack, [/рефактор/, /refactor/, /переимен/, /rename/, /вынес/, /extract/])) return "refactor"
  if (includesAny(haystack, [/наш[её]л/, /discover/, /оказал/, /выясн/, /found that/, /turns out/])) return "discovery"
  if (
    WRITE_TOOLS.has(tool) &&
    includesAny(haystack, [/добав/, /созда/, /added/, /created/, /implement/, /реализ/, /новы/])
  )
    return "feature"
  return "change"
}

/**
 * The `code--chill` filter: record only what would hurt to rebuild.
 * Errors are always kept; decisions, bugfixes and discoveries are always kept;
 * write-tool calls and substantial outputs are kept; a tiny read of a tiny
 * result is noise and is dropped.
 */
export function shouldRecordObservation(observation: SessionObservation): boolean {
  if (observation.failed) return true
  if (observation.type === "decision" || observation.type === "bugfix" || observation.type === "discovery")
    return true
  if (WRITE_TOOLS.has(observation.tool)) return true
  return observation.text.length >= 400
}

/** Builds one observation from a settled tool call; `undefined` means the chill filter dropped it. */
export function buildObservation(input: {
  readonly sessionID: string
  readonly toolUseID: string
  readonly tool: string
  readonly inputText: string
  readonly outputText: string
  readonly error?: string
}): SessionObservation | undefined {
  const failed = input.error !== undefined && input.error !== ""
  const type = classifyObservation(input.tool, input.inputText, input.outputText, failed)
  const firstLine = (input.outputText || input.inputText).split("\n").find((line) => line.trim() !== "") ?? input.tool
  const title = firstLine.trim().slice(0, 120)
  const text = [
    `Tool ${input.tool} (${type})${failed ? " — failed" : ""}: ${title}`,
    `Input: ${truncateToolIO(input.inputText, 2048)}`,
    `Output: ${truncateToolIO(input.outputText)}`,
    ...(failed ? [`Error: ${truncateToolIO(input.error ?? "", 2048)}`] : []),
  ].join("\n")
  const observation: SessionObservation = {
    sessionID: input.sessionID,
    toolUseID: input.toolUseID,
    tool: input.tool,
    type,
    title,
    text,
    failed,
    createdAt: Date.now(),
  }
  return shouldRecordObservation(observation) ? observation : undefined
}

/** At least one kept observation means there was something to remember. */
export const worthSummarizing = (observations: number): boolean => observations >= MIN_OBSERVATIONS_FOR_SUMMARY

const SECTION_PRIORITY: ReadonlyArray<{ readonly heading: string; readonly types: ReadonlyArray<ObservationType> }> = [
  { heading: "Decisions", types: ["decision"] },
  { heading: "Lessons", types: ["bugfix", "discovery"] },
  { heading: "Changes", types: ["feature", "refactor", "change"] },
]

const bulletFor = (observation: SessionObservation): string =>
  `- [${observation.type}] ${observation.tool}: ${observation.title}`.slice(0, 300)

/** Extractive session summary: no model call, deterministic, decisions and lessons first. */
export function renderMemory(sessionID: string, observations: ReadonlyArray<SessionObservation>): string {
  const lines = [`# Session memory — ${sessionID}`, ""]
  for (const section of SECTION_PRIORITY) {
    const items = observations.filter((item) => section.types.includes(item.type))
    if (items.length === 0) continue
    lines.push(`## ${section.heading}`, ...items.map(bulletFor), "")
  }
  return lines.join("\n")
}

/**
 * Trims a memory.md draft to `MEMORY_MAX_BYTES`, keeping decisions and
 * lessons first and dropping lower-priority bullets from the end. Always
 * returns text within the limit.
 */
export function trimMemoryToLimit(
  markdown: string,
  limit: number = MEMORY_MAX_BYTES,
): { readonly text: string; readonly omitted: number } {
  if (byteLength(markdown) <= limit) return { text: markdown, omitted: 0 }
  const lines = markdown.split("\n")
  const header = lines.slice(0, 2).join("\n")
  const sections = SECTION_PRIORITY.map((section) => {
    const start = lines.findIndex((line) => line === `## ${section.heading}`)
    if (start === -1) return { heading: section.heading, bullets: [] as Array<string> }
    const end = lines.findIndex((line, index) => index > start && line.startsWith("## "))
    return {
      heading: section.heading,
      bullets: lines.slice(start + 1, end === -1 ? undefined : end).filter((line) => line.startsWith("- ")),
    }
  })
  const totalBullets = sections.reduce((total, section) => total + section.bullets.length, 0)
  if (totalBullets === 0) {
    // Unstructured text (e.g. a model summary without ## sections): cut by bytes, keep the head.
    const marker = "\n…[truncated]"
    const keep = Math.max(0, limit - byteLength(marker))
    const head = new TextDecoder().decode(new TextEncoder().encode(markdown).subarray(0, keep))
    return { text: `${head}${marker}`, omitted: 0 }
  }
  let kept = 0
  const out = [header, ""]
  for (const section of sections) {
    const keptBullets: Array<string> = []
    for (const bullet of section.bullets) {
      const candidate = [...out, `## ${section.heading}`, ...keptBullets, bullet, ""].join("\n")
      if (byteLength(candidate) > limit) break
      keptBullets.push(bullet)
    }
    if (keptBullets.length === 0) continue
    out.push(`## ${section.heading}`, ...keptBullets, "")
    kept += keptBullets.length
  }
  const text = out.join("\n").trimEnd() + "\n"
  return { text, omitted: totalBullets - kept }
}

/**
 * Start-of-session budget: memory.md first, then handoff.md, cut at 12 000
 * characters total. Empty memory costs 0 characters.
 */
export function applyStartBudget(
  memory: string,
  handoff: string,
  budget: number = START_BUDGET_CHARS,
): string {
  const parts: Array<string> = []
  let used = 0
  const take = (label: string, text: string) => {
    const trimmed = text.trim()
    if (trimmed === "") return
    // Markers count against the budget too, so the injected text never exceeds it.
    const overhead = 2 * label.length + 7
    if (used + overhead >= budget) return
    const room = budget - used - overhead
    const chunk = trimmed.length > room ? trimmed.slice(0, room) : trimmed
    parts.push(`<${label}>\n${chunk}\n</${label}>`)
    used += overhead + chunk.length
  }
  take("session-memory", memory)
  take("session-handoff", handoff)
  return parts.join("\n")
}

/** Re-inject after compaction: the session summary rides the checkpoint message that opens later requests. */
export function reinjectSummary(compactionText: string, memorySummary: string): string {
  const trimmed = memorySummary.trim()
  if (trimmed === "") return compactionText
  return `${compactionText}\n\n<session-memory>\n${trimmed}\n</session-memory>`
}

/** Picks the cheapest model that can do trivial work — the B10 router, tier `trivial`. */
export function pickSummaryModel(catalog: ReadonlyArray<ModelRouter.CatalogModel>): {
  readonly providerID: string | undefined
  readonly id: string
  readonly variant?: string
  readonly reason: string
} {
  if (catalog.length === 0) throw new Error("SessionMemory.pickSummaryModel: empty model catalog")
  const candidates = catalog.map((model) => (model.providerID ? `${model.providerID}/${model.id}` : model.id))
  const routed = ModelRouter.route({ tier: "trivial", candidates, catalog })
  const [providerID, id] = routed.model.includes("/")
    ? [routed.model.slice(0, routed.model.indexOf("/")), routed.model.slice(routed.model.indexOf("/") + 1)]
    : [undefined, routed.model]
  return { providerID, id, ...(routed.variant ? { variant: routed.variant } : {}), reason: routed.reason }
}

/** The prompt a cheap model gets for a Stop summary; observations are pre-truncated so the prompt stays small. */
export function buildSummaryPrompt(sessionID: string, observations: ReadonlyArray<SessionObservation>): string {
  const body = observations
    .map((item) => `[${item.type}] ${item.tool}: ${item.title}`)
    .join("\n")
    .slice(0, 8000)
  return [
    `Summarize session ${sessionID} from its tool observations. Write in the session language.`,
    "Keep it short and concrete: decisions first, then lessons (what broke and how it was fixed), then other changes.",
    "End with three lines: What works / What does not work / Next step.",
    "",
    body,
    "",
  ].join("\n")
}

// ---------------------------------------------------------------------------
// Durable state + journal (single write point for L3 records)
// ---------------------------------------------------------------------------

const freshState = (sessionID: string): SessionState => ({
  version: 1,
  sessionID,
  recordedToolUseIDs: [],
  observations: 0,
})

const parseState = (sessionID: string, text: string | undefined): SessionState => {
  if (text === undefined) return freshState(sessionID)
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== "object" || parsed === null || !Array.isArray((parsed as { recordedToolUseIDs?: unknown }).recordedToolUseIDs))
      return freshState(sessionID)
    const state = parsed as SessionState
    return { ...freshState(sessionID), ...state, version: 1, sessionID }
  } catch {
    // A corrupt state file reads as fresh state, never a stuck session.
    return freshState(sessionID)
  }
}

/**
 * Synchronous small-file read. Session memory files are ≤ 12 KiB and this
 * runs inside request preparation (`Instructions.read`), where an async yield
 * lets a TestClock-driven retry window advance past the retry: the second
 * request then registers its stream sleep after the clock already passed,
 * and the retry never fires (session-runner backoff tests). A sync read
 * completes atomically, so no such interleave is possible. Missing or
 * unreadable files read as undefined — a broken memory file must never fail
 * request preparation (the old async version failed non-ENOENT reads; the
 * callers treat "unreadable" as "absent", which is the safe direction).
 */
const readFileSafe = (file: string): Effect.Effect<string | undefined, never> =>
  Effect.sync(() => {
    try {
      return readFileSync(file, "utf8")
    } catch {
      return undefined
    }
  })

/** Recover from a failure without swallowing an interruption: an interrupted fiber must die, not fall back. */
const recoverUnlessInterrupted =
  <A>(fallback: (cause: Cause.Cause<unknown>) => Effect.Effect<A, never>) =>
  (cause: Cause.Cause<unknown>) =>
    Cause.hasInterruptsOnly(cause) ? Effect.interrupt : fallback(cause)

const readState = (directory: string, sessionID: string) =>
  readFileSafe(pathsFor(directory, sessionID).state).pipe(
    Effect.map((text) => parseState(sessionID, text)),
  )

const writeState = (directory: string, state: SessionState) =>
  Effect.tryPromise({
    try: () => WriteAtomic.writeAtomic(pathsFor(directory, state.sessionID).state, JSON.stringify(state, null, 2) + "\n"),
    catch: (cause) => fail(`Could not write session state for ${state.sessionID}: ${cause instanceof Error ? cause.message : String(cause)}`),
  })

const parseJournal = (text: string | undefined): Array<SessionObservation> => {
  if (text === undefined || text.trim() === "") return []
  return text
    .split("\n")
    .flatMap((line) => {
      if (line.trim() === "") return []
      try {
        const parsed = JSON.parse(line) as SessionObservation
        return typeof parsed === "object" && parsed !== null && typeof parsed.toolUseID === "string" ? [parsed] : []
      } catch {
        return []
      }
    })
}

// One lock per session folder, so concurrent tool fibers (and processes) never
// interleave a journal append with the state update that marks it recorded.
const locked = <A>(sessionID: string, effect: Effect.Effect<A, SessionMemoryError>) =>
  Effect.scoped(
    Flock.effect(`session-memory:${sessionID}`).pipe(
      Effect.andThen(effect),
      Effect.mapError((cause: unknown) =>
        cause instanceof SessionMemoryError
          ? cause
          : fail(`Could not lock session memory for ${sessionID}: ${cause instanceof Error ? cause.message : String(cause)}`),
      ),
    ),
  )

/** Lazily opened, process-lifetime MemoryEngine per project directory (same precedent as `getMemoryEngine`). */
const engines = new Map<string, MemoryEngine>()

export function openSessionEngine(directory: string): MemoryEngine {
  const cached = engines.get(directory)
  if (cached) return cached
  const engine = MemoryEngine.open({ path: path.join(directory, ".orchestra", "memory.db") })
  engines.set(directory, engine)
  return engine
}


// Directories whose engine failed to open (a build without the Bun sqlite
// engine): the session keeps recording to the file journal only.
const degradedEngineDirs = new Set<string>()

/**
 * Like openSessionEngine, but never throws: the engine opens eagerly and a
 * build without the Bun sqlite engine cannot construct it. Returns no engine
 * then, so the caller records to the file journal only; becameDegraded is
 * true exactly once per directory, so the caller warns once.
 */
export function tryOpenSessionEngine(directory: string): { engine?: MemoryEngine; becameDegraded: boolean } {
  if (degradedEngineDirs.has(directory)) return { becameDegraded: false }
  try {
    return { engine: openSessionEngine(directory), becameDegraded: false }
  } catch {
    degradedEngineDirs.add(directory)
    return { becameDegraded: true }
  }
}

export interface CaptureInput {
  readonly directory: string
  readonly sessionID: string
  readonly toolUseID: string
  readonly tool: string
  readonly inputText: string
  readonly outputText: string
  readonly error?: string
  /** When given, the observation also lands in MemoryEngine (the single write point). */
  readonly engine?: MemoryEngine
  /**
   * Secret scrubber, wired by the live call site in `session/runner/llm.ts`
   * to the foundation slice (`memory/scrub.ts`, `scrubText`). When omitted
   * the text is written as-is — tests only; never leave a live capture
   * unwired, raw tool I/O may carry secrets.
   */
  readonly scrub?: (text: string) => string
}

export type CaptureResult = { readonly status: "recorded" } | { readonly status: "duplicate" } | { readonly status: "filtered" }

/**
 * Records one settled tool call: idempotent on (session + tool call), chill-filtered,
 * raw I/O truncated at 64 KiB. Never fails the caller: a memory write must never
 * fail the step it observes — failures are warnings, the journal stays the record.
 */
export const captureToolUse = Effect.fn("SessionMemory.captureToolUse")(function* (
  input: CaptureInput,
): Effect.fn.Return<CaptureResult> {
  const scrub = input.scrub ?? ((text: string) => text)
  const observation = buildObservation({
    sessionID: input.sessionID,
    toolUseID: input.toolUseID,
    tool: input.tool,
    inputText: scrub(input.inputText),
    outputText: scrub(input.outputText),
    error: input.error === undefined ? undefined : scrub(input.error),
  })
  if (observation === undefined) return { status: "filtered" } as const
  const paths = pathsFor(input.directory, input.sessionID)
  return yield* locked(
    input.sessionID,
    Effect.gen(function* () {
      const state = yield* readState(input.directory, input.sessionID)
      if (state.recordedToolUseIDs.includes(input.toolUseID)) return { status: "duplicate" } as const
      yield* Effect.tryPromise({
        try: async () => {
          await mkdir(paths.dir, { recursive: true })
          await appendFile(paths.journal, JSON.stringify(observation) + "\n", "utf8")
        },
        catch: (cause) =>
          fail(`Could not append session journal for ${input.sessionID}: ${cause instanceof Error ? cause.message : String(cause)}`),
      })
      if (input.engine) {
        try {
          input.engine.remember({
            text: observation.text,
            scope: "project",
            source: `session:${input.sessionID}`,
            entity: { name: `session:${input.sessionID}`, kind: "session", summary: observation.title },
          })
        } catch (cause) {
          yield* Effect.logWarning("Session memory engine write failed; journal keeps the record", {
            sessionID: input.sessionID,
            toolUseID: input.toolUseID,
            error: cause instanceof Error ? cause.message : String(cause),
          })
        }
      }
      yield* writeState(input.directory, {
        ...state,
        recordedToolUseIDs: [...state.recordedToolUseIDs, input.toolUseID],
        observations: state.observations + 1,
      })
      return { status: "recorded" } as const
    }),
  ).pipe(
    Effect.catchCause(
      recoverUnlessInterrupted((cause) =>
        Effect.logWarning("Session memory capture failed", {
          sessionID: input.sessionID,
          toolUseID: input.toolUseID,
          error: String(cause),
        }).pipe(Effect.as({ status: "filtered" } as const)),
      ),
    ),
  )
})

export interface FinalizeOptions {
  /**
   * Cheap-model summarizer (B10 router pick + prompt from `buildSummaryPrompt`).
   * Omitted means the extractive summary. Any failure falls back to extractive —
   * a Stop summary must never fail the stop.
   */
  readonly summarize?: (prompt: string) => Effect.Effect<string, unknown>
}

export type FinalizeResult =
  | { readonly status: "finalized"; readonly observations: number; readonly bytes: number; readonly scratched: boolean }
  | { readonly status: "skipped"; readonly reason: "nothing-to-remember" | "finalize-failed"; readonly observations: number }

/**
 * Stop hook: writes `memory.md` (≤ 8 KiB, decisions and lessons first) and
 * guarantees `handoff.md` exists (a stub when the agent wrote none — never
 * overwriting an agent-written handoff). Empty/garbage sessions are skipped:
 * nothing is summarized, no model is called.
 */
export const finalizeSession = Effect.fn("SessionMemory.finalizeSession")(function* (
  directory: string,
  sessionID: string,
  options?: FinalizeOptions,
): Effect.fn.Return<FinalizeResult, SessionMemoryError> {
  const paths = pathsFor(directory, sessionID)
  const observations = yield* readFileSafe(paths.journal).pipe(Effect.map(parseJournal))
  // handoff.md is mandatory at stop, even for a session with nothing to remember.
  yield* SessionHandoff.writeStubIfMissing(directory, sessionID, "inactivity").pipe(
    Effect.catchCause(
      recoverUnlessInterrupted((cause) =>
        Effect.logWarning("Session memory finalize could not ensure handoff", { sessionID, error: String(cause) }),
      ),
    ),
  )
  if (!worthSummarizing(observations.length)) {
    return { status: "skipped", reason: "nothing-to-remember", observations: observations.length } as const
  }
  const prompt = buildSummaryPrompt(sessionID, observations)
  const summarized = options?.summarize
    ? yield* options.summarize(prompt).pipe(
        Effect.catchCause(
          recoverUnlessInterrupted((cause) =>
            Effect.logWarning("Session summary model call failed; using the extractive summary", {
              sessionID,
              error: String(cause),
            }).pipe(Effect.as(renderMemory(sessionID, observations))),
          ),
        ),
      )
    : renderMemory(sessionID, observations)
  const trimmed = trimMemoryToLimit(summarized)
  const full = renderMemory(sessionID, observations)
  const scratched = trimmed.omitted > 0 || byteLength(summarized) > MEMORY_MAX_BYTES
  yield* Effect.tryPromise({
    try: async () => {
      await mkdir(paths.dir, { recursive: true })
      await WriteAtomic.writeAtomic(paths.memory, trimmed.text)
      if (scratched) await WriteAtomic.writeAtomic(paths.scratch, full)
    },
    catch: (cause) =>
      fail(`Could not write session memory for ${sessionID}: ${cause instanceof Error ? cause.message : String(cause)}`),
  })
  const state = yield* readState(directory, sessionID)
  yield* writeState(directory, { ...state, observations: observations.length, lastFinalizedAt: Date.now() })
  return {
    status: "finalized",
    observations: observations.length,
    bytes: byteLength(trimmed.text),
    scratched,
  } as const
})

/**
 * Checkpoint BEFORE compaction rewrites the context: snapshots memory.md +
 * handoff.md under `checkpoint/`. A crash between checkpoint and compaction
 * loses nothing — the snapshot stays on disk and `loadCheckpointSummary`
 * reads it back.
 */
export const checkpointBeforeCompaction = Effect.fn("SessionMemory.checkpointBeforeCompaction")(function* (
  directory: string,
  sessionID: string,
): Effect.fn.Return<Checkpoint, SessionMemoryError> {
  const paths = pathsFor(directory, sessionID)
  const memory = yield* readFileSafe(paths.memory)
  const handoff = yield* readFileSafe(paths.handoff)
  if (memory === undefined && handoff === undefined) return emptyCheckpoint()
  yield* Effect.tryPromise({
    try: async () => {
      await mkdir(paths.checkpointDir, { recursive: true })
      if (memory !== undefined) await WriteAtomic.writeAtomic(paths.checkpointMemory, memory)
      if (handoff !== undefined) await WriteAtomic.writeAtomic(paths.checkpointHandoff, handoff)
    },
    catch: (cause) =>
      fail(`Could not write session memory checkpoint for ${sessionID}: ${cause instanceof Error ? cause.message : String(cause)}`),
  })
  const state = yield* readState(directory, sessionID)
  yield* writeState(directory, {
    ...state,
    checkpoint: { memory: memory !== undefined, handoff: handoff !== undefined, at: Date.now() },
  })
  return {
    memory: memory !== undefined,
    handoff: handoff !== undefined,
    ...(memory !== undefined ? { summary: memory } : {}),
    at: Date.now(),
  }
})

/** Reads the checkpointed memory.md (falling back to the live one) for re-inject after compaction. */
export const loadCheckpointSummary = (directory: string, sessionID: string): Effect.Effect<string | undefined, never> => {
  const paths = pathsFor(directory, sessionID)
  return readFileSafe(paths.checkpointMemory).pipe(
    Effect.flatMap((checkpoint) =>
      checkpoint !== undefined ? Effect.succeed(checkpoint) : readFileSafe(paths.memory),
    ),
  )
}

/** Start-of-session load: previous memory.md + handoff.md within the 12 000-character budget. */
export const loadStartContext = (directory: string, sessionID: string): Effect.Effect<string, never> => {
  const paths = pathsFor(directory, sessionID)
  return Effect.all([readFileSafe(paths.memory), readFileSafe(paths.handoff)]).pipe(
    Effect.map(([memory, handoff]) => applyStartBudget(memory ?? "", handoff ?? "")),
  )
}

/**
 * Session memory as an instruction source: loads at session start within the
 * budget; empty memory costs 0 tokens (renders as `removed`, like the empty
 * long-term blocks in `memory/instructions.ts`).
 */
export function instructions(directory: string, sessionID: string): Instructions.List {
  return Instructions.make({
    key: Instructions.Key.make("core/memory/session"),
    codec: Schema.toCodecJson(Schema.String),
    read: loadStartContext(directory, sessionID).pipe(
      Effect.map((text) => (text === "" ? Instructions.removed : text)),
    ),
    render: {
      initial: (text) => `<session-memory>\n${text}\n</session-memory>`,
      changed: (_previous, current) => `<session-memory>\n${current}\n</session-memory>`,
      removed: () => "Session memory is empty now; earlier session memory no longer applies.",
    },
  })
}
