export * as SessionRequestMeasurement from "./request-measurement.js"

import path from "path"
import { randomUUID } from "node:crypto"
import { chmod, mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises"
import { Cause, Effect } from "effect"
import { Global } from "@orchestra/util/global"

// Safe per-request measurement (Step 0): numbers only, no prompt text, no filenames, no URLs, no
// headers, no keys, no error bodies. Every record is built from explicit scalar fields — never
// from `...request` spreads, arbitrary metadata or serialized errors — so a secret cannot ride
// along by accident. This is a diagnostic export, not a second source of charges: a local
// attempt ID does not equal a provider request ID, and retries hidden inside an SDK stay
// "uncounted" until they are instrumented.

export const schemaVersion = 1

// Set ORCHESTRA_REQUEST_MEASUREMENT=1 to collect the safe numbers. Exactly "1" opts in: unset,
// empty, "0" or "false" all stay off, and it never enables the detailed ORCHESTRA_REQUEST_REPORT
// mode (which persists prompt text).
export const enabled = () => process.env.ORCHESTRA_REQUEST_MEASUREMENT === "1"

/** Where measurement files live; ORCHESTRA_REQUEST_MEASUREMENT_DIR overrides it (tests, exports). */
export const measurementDir = () =>
  process.env.ORCHESTRA_REQUEST_MEASUREMENT_DIR ?? path.join(Global.Path.log, "measurements")

export const DEFAULT_RETENTION_DAYS = 7

export const retentionDays = () => {
  const parsed = Number.parseInt(process.env.ORCHESTRA_REQUEST_MEASUREMENT_RETENTION_DAYS ?? "", 10)
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : DEFAULT_RETENTION_DAYS
}

/** One record never grows past this; a bigger line is a bug, so it is dropped, not truncated. */
export const MAX_LINE_BYTES = 64 * 1024

/** What this collector covers; it is not full per-request billing. */
export const coverage = "primary-sizes"

export const PHASES = ["primary", "intake", "title", "compaction", "summary", "unknown"] as const
export type Phase = (typeof PHASES)[number]

export const OUTCOMES = ["completed", "failed", "cancelled", "unknown"] as const
export type Outcome = (typeof OUTCOMES)[number]

// Allowed string fields carry trusted IDs and enum labels, never prose: short, no whitespace or
// quotes, so a stray chat title or prompt fragment cannot land in the JSONL.
const idOf = (value: string, field: string): string => {
  if (typeof value !== "string" || value.length === 0 || value.length > 256 || /[\s"]/.test(value))
    throw new Error(`measurement: invalid ${field}`)
  return value
}

const nonNeg = (value: number, field: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    throw new Error(`measurement: invalid ${field}`)
  return value
}

const nonNegOrNull = (value: number | null, field: string): number | null =>
  value === null ? null : nonNeg(value, field)

const phaseOf = (value: string): Phase => {
  if (!(PHASES as ReadonlyArray<string>).includes(value)) throw new Error("measurement: invalid phase")
  return value as Phase
}

const outcomeOf = (value: string): Outcome => {
  if (!(OUTCOMES as ReadonlyArray<string>).includes(value)) throw new Error("measurement: invalid outcome")
  return value as Outcome
}

const usageOf = (usage: Usage): Usage => ({
  input: nonNegOrNull(usage.input, "usage.input"),
  output: nonNegOrNull(usage.output, "usage.output"),
  reasoning: nonNegOrNull(usage.reasoning, "usage.reasoning"),
  cacheRead: nonNegOrNull(usage.cacheRead, "usage.cacheRead"),
  cacheWrite: nonNegOrNull(usage.cacheWrite, "usage.cacheWrite"),
})

const costOf = (cost: Cost): Cost => ({
  recordedUSD: nonNegOrNull(cost.recordedUSD, "cost.recordedUSD"),
  estimatedUSD: nonNegOrNull(cost.estimatedUSD, "cost.estimatedUSD"),
  source: (["provider", "catalog", "unknown"] as const).includes(cost.source) ? cost.source : "unknown",
})

/**
 * Where the goal/task/role link came from. Never derived from text or a
 * chat title. Reserved for a future assignment seam: no producer passes an
 * assignment today, so every record has attribution "unknown" and null
 * goalID/taskID/role. Treat the three fields as unsupported, not as
 * evidence that the request had no goal, task or role.
 */
export type Attribution = "assignment" | "unknown"

export interface Usage {
  readonly input: number | null
  /** Visible output only; excludes reasoning, so output + reasoning never double-counts. */
  readonly output: number | null
  readonly reasoning: number | null
  readonly cacheRead: number | null
  readonly cacheWrite: number | null
}

export interface Cost {
  readonly recordedUSD: number | null
  readonly estimatedUSD: number | null
  readonly source: "provider" | "catalog" | "unknown"
}

export interface Attempt {
  readonly schemaVersion: typeof schemaVersion
  readonly measurementID: string
  readonly sessionID: string
  readonly logicalRequestID: string
  readonly attemptID: string
  readonly retryOf: string | null
  readonly goalID: string | null
  readonly taskID: string | null
  readonly role: string | null
  readonly attribution: Attribution
  readonly phase: Phase
  readonly providerID: string
  readonly modelID: string
  readonly startedAt: number
  readonly endedAt: number | null
  /**
   * Elapsed wall time from request formation to the step's settlement of
   * this attempt: it spans queueing, the provider call, and any in-step
   * work until the branch resolves. It is NOT provider latency - the
   * provider's own timing is not available at this seam.
   */
  readonly durationMs: number | null
  readonly outcome: Outcome
  readonly usage: Usage
  readonly cost: Cost
  readonly toolCount: number
  readonly messageCount: number
  readonly estimates: {
    readonly system: number | null
    readonly tools: number | null
    readonly history: number | null
    readonly method: string
  }
  /** Retries the SDK made without telling us; a count we cannot see is not zero. */
  readonly sdkRetries: "uncounted"
}

export interface BeginInput {
  readonly measurementID: string
  readonly sessionID: string
  readonly logicalRequestID: string
  readonly attemptID: string
  readonly retryOf?: string
  readonly assignment?: {
    readonly goalID?: string
    readonly taskID?: string
    readonly role?: string
  }
  readonly phase: Phase
  readonly providerID: string
  readonly modelID: string
  readonly startedAt: number
  readonly toolCount: number
  readonly messageCount: number
  readonly estimates?: {
    readonly system?: number
    readonly tools?: number
    readonly history?: number
    readonly method: string
  }
}

export interface FinishInput {
  readonly outcome: Exclude<Outcome, "unknown">
  readonly endedAt: number
  readonly usage?: Usage
  readonly cost?: Cost
}

const unknownUsage: Usage = { input: null, output: null, reasoning: null, cacheRead: null, cacheWrite: null }
const unknownCost: Cost = { recordedUSD: null, estimatedUSD: null, source: "unknown" }

export interface Ledger {
  readonly attempts: Readonly<Record<string, Attempt>>
}

export const empty: Ledger = { attempts: {} }

export function attempt(ledger: Ledger, attemptID: string): Attempt | undefined {
  return ledger.attempts[attemptID]
}

export function open(input: BeginInput): Attempt {
  return {
    schemaVersion,
    measurementID: idOf(input.measurementID, "measurementID"),
    sessionID: idOf(input.sessionID, "sessionID"),
    logicalRequestID: idOf(input.logicalRequestID, "logicalRequestID"),
    attemptID: idOf(input.attemptID, "attemptID"),
    retryOf: input.retryOf === undefined ? null : idOf(input.retryOf, "retryOf"),
    goalID: input.assignment?.goalID === undefined ? null : idOf(input.assignment.goalID, "goalID"),
    taskID: input.assignment?.taskID === undefined ? null : idOf(input.assignment.taskID, "taskID"),
    role: input.assignment?.role === undefined ? null : idOf(input.assignment.role, "role"),
    attribution: input.assignment ? "assignment" : "unknown",
    phase: phaseOf(input.phase),
    providerID: idOf(input.providerID, "providerID"),
    modelID: idOf(input.modelID, "modelID"),
    startedAt: nonNeg(input.startedAt, "startedAt"),
    endedAt: null,
    durationMs: null,
    outcome: "unknown",
    usage: unknownUsage,
    cost: unknownCost,
    toolCount: nonNeg(input.toolCount, "toolCount"),
    messageCount: nonNeg(input.messageCount, "messageCount"),
    estimates: {
      system: input.estimates?.system === undefined ? null : nonNeg(input.estimates.system, "estimates.system"),
      tools: input.estimates?.tools === undefined ? null : nonNeg(input.estimates.tools, "estimates.tools"),
      history: input.estimates?.history === undefined ? null : nonNeg(input.estimates.history, "estimates.history"),
      method: input.estimates?.method ?? "none",
    },
    sdkRetries: "uncounted",
  }
}

// Idempotent: an attempt ID that already exists - open or terminal - is never overwritten. The
// lifecycle owns the record; a repeated begin is a bug in the caller, not new information.
export function begin(ledger: Ledger, input: BeginInput): Ledger {
  if (input.attemptID in ledger.attempts) return ledger
  return { attempts: { ...ledger.attempts, [input.attemptID]: open(input) } }
}

/** Terminal and idempotent: a duplicate finish returns the ledger unchanged, never a second record. */
export function finish(ledger: Ledger, attemptID: string, input: FinishInput): Ledger {
  const current = ledger.attempts[attemptID]
  if (!current || current.outcome !== "unknown") return ledger
  const endedAt = nonNeg(input.endedAt, "endedAt")
  return {
    attempts: {
      ...ledger.attempts,
      [attemptID]: {
        ...current,
        endedAt,
        durationMs: Math.max(0, endedAt - current.startedAt),
        outcome: outcomeOf(input.outcome),
        usage: input.usage === undefined ? current.usage : usageOf(input.usage),
        cost: input.cost === undefined ? current.cost : costOf(input.cost),
      },
    },
  }
}

// One line of JSON per attempt, keys in a fixed order and values taken field by field from the
// contract, so the same attempt always serializes to the same bytes and nothing outside the
// contract can leak into the output.
export function toLine(record: Attempt): string {
  return JSON.stringify({
    schemaVersion: record.schemaVersion,
    measurementID: record.measurementID,
    sessionID: record.sessionID,
    logicalRequestID: record.logicalRequestID,
    attemptID: record.attemptID,
    retryOf: record.retryOf,
    goalID: record.goalID,
    taskID: record.taskID,
    role: record.role,
    attribution: record.attribution,
    phase: record.phase,
    providerID: record.providerID,
    modelID: record.modelID,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    durationMs: record.durationMs,
    outcome: record.outcome,
    usage: {
      input: record.usage.input,
      output: record.usage.output,
      reasoning: record.usage.reasoning,
      cacheRead: record.usage.cacheRead,
      cacheWrite: record.usage.cacheWrite,
    },
    cost: {
      recordedUSD: record.cost.recordedUSD,
      estimatedUSD: record.cost.estimatedUSD,
      source: record.cost.source,
    },
    toolCount: record.toolCount,
    messageCount: record.messageCount,
    estimates: {
      system: record.estimates.system,
      tools: record.estimates.tools,
      history: record.estimates.history,
      method: record.estimates.method,
    },
    sdkRetries: record.sdkRetries,
  })
}

// About 3.5 characters per token across prose, JSON schema and code; providers differ by ~15%.
// The same heuristic the detailed request report uses, kept honest by carrying the method name.
export const estimateMethod = "chars/3.5"
export const estimateTokens = (text: string) => Math.ceil(text.length / 3.5)

export interface RequestSizes {
  readonly providerID: string
  readonly modelID: string
  readonly toolCount: number
  readonly messageCount: number
  readonly estimates: {
    readonly system: number
    readonly tools: number
    readonly history: number
    readonly method: string
  }
}

// Pure extraction of the numbers from a formed request. The request is only read, never
// mutated, and nothing is sent back to the provider; the strings are measured and dropped.
export function sizesOf(request: {
  readonly model: { readonly provider: string; readonly id: string }
  readonly system: ReadonlyArray<{ readonly text: string }>
  readonly tools: ReadonlyArray<{ readonly name: string; readonly description?: string | undefined }>
  readonly messages: ReadonlyArray<{ readonly content: unknown }>
}): RequestSizes {
  return {
    providerID: request.model.provider,
    modelID: request.model.id,
    toolCount: request.tools.length,
    messageCount: request.messages.length,
    estimates: {
      system: request.system.reduce((total, part) => total + estimateTokens(part.text), 0),
      tools: request.tools.reduce(
        (total, tool) =>
          total +
          estimateTokens(
            JSON.stringify({
              name: tool.name,
              description: tool.description,
              input: "inputSchema" in tool ? (tool as { inputSchema?: unknown }).inputSchema : undefined,
            }),
          ),
        0,
      ),
      history: request.messages.reduce((total, message) => total + estimateTokens(JSON.stringify(message.content)), 0),
      method: estimateMethod,
    },
  }
}

/** The line written for one formed request: the coverage label plus the safe record. */
export function sizesLine(record: Attempt): string {
  return JSON.stringify({ coverage, record: JSON.parse(toLine(record)) as unknown })
}

const ownFile = /^[0-9a-f-]+\.jsonl$/

/** At most this many directory entries are examined in one retention sweep. */
export const SWEEP_EXAMINE_LIMIT = 100
/** At most one retention sweep per interval per directory and process, however often writes happen. */
export const SWEEP_INTERVAL_MS = 60 * 60 * 1000

interface DirectorySweep {
  lastSweepAt: number
  /** Rotation offset into the next listing snapshot: successive sweeps walk the whole directory. */
  offset: number
  inFlight: Promise<number> | undefined
}

// Sweep state is per directory: one measurement directory must never throttle
// another or move its window. Directories are few (normally exactly one), so
// the map stays tiny.
const directorySweeps = new Map<string, DirectorySweep>()

const sweepStateFor = (directory: string): DirectorySweep => {
  const existing = directorySweeps.get(directory)
  if (existing) return existing
  const created: DirectorySweep = { lastSweepAt: Number.NEGATIVE_INFINITY, offset: 0, inFlight: undefined }
  directorySweeps.set(directory, created)
  return created
}

/**
 * Delete measurement files older than the retention window. Only our own
 * files; anything else stays. What is bounded is the per-entry work: each
 * call stats and unlinks within a window of at most `limit` entries (readdir
 * itself still snapshots the whole listing). The persisted rotation offset
 * moves that window on every call, so successive calls visit every entry and
 * an expired file can never starve behind a fresh prefix. Returns how many
 * files it removed.
 */
export const pruneOldMeasurements = async (directory: string, now = Date.now(), limit = SWEEP_EXAMINE_LIMIT) => {
  const state = sweepStateFor(directory)
  const cutoff = now - retentionDays() * 24 * 60 * 60 * 1000
  let entries: string[]
  try {
    entries = await readdir(directory)
  } catch {
    return 0
  }
  if (entries.length === 0) return 0
  const start = state.offset % entries.length
  let removed = 0
  let examined = 0
  for (let i = 0; i < entries.length && examined < limit; i++) {
    const entry = entries[(start + i) % entries.length]!
    examined++
    if (!ownFile.test(entry)) continue
    const file = path.join(directory, entry)
    try {
      if ((await stat(file)).mtimeMs < cutoff) {
        await unlink(file)
        removed += 1
      }
    } catch {
      // A file that cannot be read or removed stays; the next sweep retries it.
    }
  }
  state.offset = (start + examined) % entries.length
  return removed
}

/**
 * The write path's retention hook, per directory: infrequent (once per
 * SWEEP_INTERVAL_MS), serialized (concurrent callers share one in-flight
 * sweep), and windowed (the sweep itself examines at most SWEEP_EXAMINE_LIMIT
 * entries, advancing the rotation offset for the next one).
 */
export const maybeSweep = (directory: string, now = Date.now()): Promise<number> => {
  const state = sweepStateFor(directory)
  if (now - state.lastSweepAt < SWEEP_INTERVAL_MS) return Promise.resolve(0)
  if (state.inFlight) return state.inFlight
  state.lastSweepAt = now
  state.inFlight = pruneOldMeasurements(directory, now).finally(() => {
    state.inFlight = undefined
  })
  return state.inFlight
}

/** Test-only: clears all per-directory sweep state so each case starts with a due sweep. */
export const resetSweepThrottleForTests = () => {
  directorySweeps.clear()
}

// Append one line to <data>/log/measurements with owner-only permissions. A write failure is
// swallowed (Effect.ignore): measurement must never break the request it only observes, never
// change a retry decision, and the warning path carries no record content.
export const writeLine = (line: string, directory = measurementDir()) =>
  Effect.tryPromise({
    try: async () => {
      if (Buffer.byteLength(line) > MAX_LINE_BYTES) return
      await mkdir(directory, { recursive: true, mode: 0o700 })
      await maybeSweep(directory)
      const file = path.join(directory, `${randomUUID()}.jsonl`)
      await writeFile(file, `${line}\n`, { mode: 0o600, flag: "wx" })
      await chmod(file, 0o600)
    },
    catch: () => new Error("measurement write failed"),
  }).pipe(Effect.ignore)

/** Explicit retry identity, supplied by the runner only when it actually retries a request. */
export interface RetryToken {
  readonly attemptID: string
  readonly logicalRequestID: string
}

// The whole primary-sizes hook behind one best-effort boundary: a serialization failure in
// sizesOf (a circular message part, a throwing toJSON) can never abort request preparation,
// and a write failure never reaches the request either. Measurement observes; it does not act.
// Returns the opened attempt identity so the caller (Prepared) can settle exactly this attempt
// and the runner can pass it back as the retry token when it retries. Linkage is never inferred:
// without an explicit token the attempt starts a new logical request.
export const recordPrimarySizes = (
  input: {
    readonly sessionID: string
    readonly request: Parameters<typeof sizesOf>[0]
    readonly startedAt?: number
    readonly retryOf?: RetryToken
  },
  directory = measurementDir(),
): Effect.Effect<RetryToken | undefined> =>
  Effect.suspend(() => {
    if (!enabled()) return Effect.succeed(undefined)
    return Effect.try({
      try: () => {
        const sizes = sizesOf(input.request)
        const attemptID = randomUUID()
        // Linkage is never inferred: only an explicit retry token from the runner joins this
        // attempt to the logical request it retries; without one it starts a new logical request.
        const ids: RetryToken = { attemptID, logicalRequestID: input.retryOf?.logicalRequestID ?? attemptID }
        const line = sizesLine(
          track(
            open({
              measurementID: randomUUID(),
              sessionID: input.sessionID,
              logicalRequestID: ids.logicalRequestID,
              attemptID,
              retryOf: input.retryOf?.attemptID,
              phase: "primary",
              providerID: sizes.providerID,
              modelID: sizes.modelID,
              startedAt: input.startedAt ?? Date.now(),
              toolCount: sizes.toolCount,
              messageCount: sizes.messageCount,
              estimates: sizes.estimates,
            }),
          ),
        )
        return { line, ids }
      },
      catch: () => new Error("measurement failed"),
    }).pipe(
      Effect.flatMap(({ line, ids }) => writeLine(line, directory).pipe(Effect.as(ids as RetryToken | undefined))),
      Effect.catchCause((cause) => (Cause.hasInterruptsOnly(cause) ? Effect.interrupt : Effect.succeed(undefined))),
    )
  })

/** What a completion line is labelled with; begin lines keep the "primary-sizes" label. */
export const completionCoverage = "primary-completion"

// The unsettled attempt opened for a primary request, held until its step settles. One entry
// per session: a session's steps are sequential. completePrimary removes the entry it settles.
const pending = new Map<string, Attempt>()

export const track = (record: Attempt): Attempt => {
  pending.set(record.sessionID, record)
  return record
}

export const pendingAttempt = (sessionID: string): Attempt | undefined => pending.get(sessionID)

/** Test hook: forget every pending attempt. */
export const untrackAll = () => pending.clear()

export function completionLine(record: Attempt): string {
  return JSON.stringify({ coverage: completionCoverage, record: JSON.parse(toLine(record)) as unknown })
}

// Finalize one pending attempt and write its completion line. The attempt ID is required:
// measurement never guesses which attempt a settlement belongs to, so a mismatched or missing
// pending attempt is a no-op, and a duplicate terminal event can never create a second record. Fully
// best-effort inside: invalid input (NaN usage, a defect in serialization) drops the completion
// and keeps the attempt open, but can never fail the step that triggered it.
export const completePrimary = (
  sessionID: string,
  input: FinishInput,
  options: { readonly attemptID: string; readonly directory?: string },
) =>
  Effect.suspend(() =>
    Effect.try({
      try: () => {
        const current = pending.get(sessionID)
        if (!current) return undefined
        if (current.attemptID !== options.attemptID) return undefined
        if (current.outcome !== "unknown") return undefined
        const finished = finish({ attempts: { [current.attemptID]: current } }, current.attemptID, input).attempts[
          current.attemptID
        ]
        if (!finished || finished.outcome === "unknown") return undefined
        pending.delete(sessionID)
        return completionLine(finished)
      },
      catch: () => new Error("measurement completion failed"),
    }).pipe(
      Effect.flatMap((line) =>
        line === undefined ? Effect.void : writeLine(line, options.directory ?? measurementDir()),
      ),
      Effect.catchCause((cause) => (Cause.hasInterruptsOnly(cause) ? Effect.interrupt : Effect.void)),
    ),
  )

export const gaps = [
  "title, compaction, summary and intake requests are not measured yet",
  "retries hidden inside the provider SDK are not counted",
  "a local attempt ID is not the provider's request ID and does not prove billed HTTP attempts",
  "retry linkage is recorded only when the runner explicitly retries (Retry/RecoverFull/Compacted/Switched); any other follow-up request starts a new logical request",
  "project filtering is not supported by schema v1 records",
] as const

export interface ExportOptions {
  /** Epoch milliseconds bounds on startedAt; either side may be omitted. */
  readonly from?: number
  readonly to?: number
  readonly sessions?: ReadonlyArray<string>
}

export interface ExportResult {
  readonly manifest: {
    readonly schemaVersion: number
    readonly coverage: ReadonlyArray<string>
    readonly gaps: ReadonlyArray<string>
    readonly estimateMethod: string
    readonly records: number
    readonly unfinished: number
    readonly skippedLines: number
    readonly window: { readonly from: number | null; readonly to: number | null }
    readonly sessions: ReadonlyArray<string> | null
  }
  readonly lines: ReadonlyArray<string>
}

// A bounded enum-like label (estimation method name), same character rules as an ID.
const labelOf = (value: unknown, field: string): string => {
  if (typeof value !== "string" || value.length === 0 || value.length > 64 || /[\s"]/.test(value))
    throw new Error(`measurement: invalid ${field}`)
  return value
}

// A stored line is untrusted input: the record is rebuilt field by field through the same
// validators a fresh open()/finish() applies - bounded ID-shaped strings and enum labels, finite
// non-negative numbers, known coverage handled by the caller. Object-typed and prose fields are
// rejected outright; a short ID-shaped string is still accepted as the ID it claims to be.
const decodeAttempt = (raw: unknown): Attempt | undefined => {
  try {
    if (typeof raw !== "object" || raw === null) return undefined
    const record = raw as Record<string, unknown>
    if (record.schemaVersion !== schemaVersion) return undefined
    if (record.sdkRetries !== "uncounted") return undefined
    const nullableId = (value: unknown, field: string): string | null =>
      value === null ? null : idOf(value as string, field)
    const nullableNumber = (value: unknown, field: string): number | null =>
      value === null ? null : nonNeg(value as number, field)
    const usage = record.usage
    const cost = record.cost
    const estimates = record.estimates
    if (typeof usage !== "object" || usage === null) return undefined
    if (typeof cost !== "object" || cost === null) return undefined
    if (typeof estimates !== "object" || estimates === null) return undefined
    const u = usage as Record<string, unknown>
    const c = cost as Record<string, unknown>
    const e = estimates as Record<string, unknown>
    if (c.source !== "provider" && c.source !== "catalog" && c.source !== "unknown") return undefined
    if (record.attribution !== "assignment" && record.attribution !== "unknown") return undefined
    return {
      schemaVersion,
      measurementID: idOf(record.measurementID as string, "measurementID"),
      sessionID: idOf(record.sessionID as string, "sessionID"),
      logicalRequestID: idOf(record.logicalRequestID as string, "logicalRequestID"),
      attemptID: idOf(record.attemptID as string, "attemptID"),
      retryOf: nullableId(record.retryOf, "retryOf"),
      goalID: nullableId(record.goalID, "goalID"),
      taskID: nullableId(record.taskID, "taskID"),
      role: nullableId(record.role, "role"),
      attribution: record.attribution,
      phase: phaseOf(record.phase as string),
      providerID: idOf(record.providerID as string, "providerID"),
      modelID: idOf(record.modelID as string, "modelID"),
      startedAt: nonNeg(record.startedAt as number, "startedAt"),
      endedAt: nullableNumber(record.endedAt, "endedAt"),
      durationMs: nullableNumber(record.durationMs, "durationMs"),
      outcome: outcomeOf(record.outcome as string),
      usage: usageOf({
        input: u.input as number | null,
        output: u.output as number | null,
        reasoning: u.reasoning as number | null,
        cacheRead: u.cacheRead as number | null,
        cacheWrite: u.cacheWrite as number | null,
      }),
      cost: {
        recordedUSD: nullableNumber(c.recordedUSD, "cost.recordedUSD"),
        estimatedUSD: nullableNumber(c.estimatedUSD, "cost.estimatedUSD"),
        source: c.source,
      },
      toolCount: nonNeg(record.toolCount as number, "toolCount"),
      messageCount: nonNeg(record.messageCount as number, "messageCount"),
      estimates: {
        system: nullableNumber(e.system, "estimates.system"),
        tools: nullableNumber(e.tools, "estimates.tools"),
        history: nullableNumber(e.history, "estimates.history"),
        method: labelOf(e.method, "estimates.method"),
      },
      sdkRetries: "uncounted",
    }
  } catch {
    return undefined
  }
}

// Fold every stored line back through the ledger: sizes lines open attempts, completion lines
// finish them, the first terminal event wins, and one attempt is exactly one record - a primary
// plus its completion is never two charges. Read and merge only; nothing is sent anywhere.
export const readExport = (directory: string, options: ExportOptions = {}) =>
  Effect.tryPromise({
    try: async () => {
      let entries: string[]
      try {
        entries = await readdir(directory)
      } catch {
        entries = []
      }
      let ledger: Ledger = empty
      let skipped = 0
      for (const entry of entries.toSorted()) {
        if (!ownFile.test(entry)) continue
        let text: string
        try {
          text = await readFile(path.join(directory, entry), "utf8")
        } catch {
          continue
        }
        for (const raw of text.split("\n")) {
          if (!raw.trim()) continue
          try {
            const parsed = JSON.parse(raw) as { coverage?: unknown; record?: unknown }
            if (parsed.coverage !== coverage && parsed.coverage !== completionCoverage) {
              skipped++
              continue
            }
            const record = decodeAttempt(parsed.record)
            if (!record) {
              skipped++
              continue
            }
            if (parsed.coverage === completionCoverage && record.outcome !== "unknown") {
              const before = ledger.attempts[record.attemptID]
              // File order is arbitrary, so the completion can arrive before its begin: keep the
              // terminal record either way, and never let a later begin reopen it.
              if (before === undefined) ledger = { attempts: { ...ledger.attempts, [record.attemptID]: record } }
              else if (before.outcome === "unknown")
                ledger = finish(ledger, record.attemptID, {
                  outcome: record.outcome,
                  endedAt: record.endedAt ?? record.startedAt,
                  usage: record.usage,
                  cost: record.cost,
                })
            } else if (!(record.attemptID in ledger.attempts)) {
              ledger = { attempts: { ...ledger.attempts, [record.attemptID]: record } }
            }
          } catch {
            skipped++
          }
        }
      }
      const sessions = options.sessions?.length ? new Set(options.sessions) : undefined
      const records = Object.values(ledger.attempts)
        .filter((record) => (sessions ? sessions.has(record.sessionID) : true))
        .filter((record) => (options.from === undefined ? true : record.startedAt >= options.from))
        .filter((record) => (options.to === undefined ? true : record.startedAt <= options.to))
        .toSorted((left, right) => left.startedAt - right.startedAt)
      return {
        manifest: {
          schemaVersion,
          coverage: [coverage, completionCoverage],
          gaps,
          estimateMethod,
          records: records.length,
          unfinished: records.filter((record) => record.outcome === "unknown").length,
          skippedLines: skipped,
          window: { from: options.from ?? null, to: options.to ?? null },
          sessions: options.sessions ?? null,
        },
        lines: records.map(toLine),
      } satisfies ExportResult
    },
    catch: (error) => (error instanceof Error ? error : new Error(String(error))),
  })
