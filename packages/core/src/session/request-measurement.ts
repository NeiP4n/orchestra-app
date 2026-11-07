export * as SessionRequestMeasurement from "./request-measurement.js"

import path from "path"
import { randomUUID } from "node:crypto"
import { chmod, mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises"
import { Effect } from "effect"
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

/** Where the goal/task/role link came from. Never derived from text or a chat title. */
export type Attribution = "assignment" | "unknown"

export interface Usage {
  readonly input: number | null
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

/** Delete measurement files older than the retention window. Only our own files; anything else stays. */
export const pruneOldMeasurements = async (directory: string, now = Date.now()) => {
  const cutoff = now - retentionDays() * 24 * 60 * 60 * 1000
  let entries: string[]
  try {
    entries = await readdir(directory)
  } catch {
    return
  }
  for (const entry of entries) {
    if (!ownFile.test(entry)) continue
    const file = path.join(directory, entry)
    try {
      if ((await stat(file)).mtimeMs < cutoff) await unlink(file)
    } catch {
      // A file that cannot be read or removed stays; the next write retries it.
    }
  }
}

// Append one line to <data>/log/measurements with owner-only permissions. A write failure is
// swallowed (Effect.ignore): measurement must never break the request it only observes, never
// change a retry decision, and the warning path carries no record content.
export const writeLine = (line: string, directory = path.join(Global.Path.log, "measurements")) =>
  Effect.tryPromise({
    try: async () => {
      if (Buffer.byteLength(line) > MAX_LINE_BYTES) return
      await mkdir(directory, { recursive: true, mode: 0o700 })
      await pruneOldMeasurements(directory)
      const file = path.join(directory, `${randomUUID()}.jsonl`)
      await writeFile(file, `${line}\n`, { mode: 0o600, flag: "wx" })
      await chmod(file, 0o600)
    },
    catch: () => new Error("measurement write failed"),
  }).pipe(Effect.ignore)

// The whole primary-sizes hook behind one best-effort boundary: a serialization failure in
// sizesOf (a circular message part, a throwing toJSON) can never abort request preparation,
// and a write failure never reaches the request either. Measurement observes; it does not act.
export const recordPrimarySizes = (
  input: {
    readonly sessionID: string
    readonly request: Parameters<typeof sizesOf>[0]
    readonly startedAt?: number
  },
  directory = path.join(Global.Path.log, "measurements"),
) =>
  Effect.suspend(() => {
    if (!enabled()) return Effect.void
    return Effect.try({
      try: () => {
        const sizes = sizesOf(input.request)
        const attemptID = randomUUID()
        return sizesLine(
          track(
            open({
              measurementID: randomUUID(),
              sessionID: input.sessionID,
              logicalRequestID: attemptID,
              attemptID,
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
      },
      catch: () => new Error("measurement failed"),
    }).pipe(
      Effect.flatMap((line) => writeLine(line, directory)),
      Effect.ignore,
    )
  })
