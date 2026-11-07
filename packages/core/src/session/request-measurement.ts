export * as SessionRequestMeasurement from "./request-measurement.js"

// Safe per-request measurement (Step 0): numbers only, no prompt text, no filenames, no URLs, no
// headers, no keys, no error bodies. Every record is built from explicit scalar fields — never
// from `...request` spreads, arbitrary metadata or serialized errors — so a secret cannot ride
// along by accident. This is a diagnostic export, not a second source of charges: a local
// attempt ID does not equal a provider request ID, and retries hidden inside an SDK stay
// "uncounted" until they are instrumented.

export const schemaVersion = 1

export type Phase = "primary" | "intake" | "title" | "compaction" | "summary" | "unknown"

export type Outcome = "completed" | "failed" | "cancelled" | "unknown"

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

export function begin(ledger: Ledger, input: BeginInput): Ledger {
  const opened: Attempt = {
    schemaVersion,
    measurementID: input.measurementID,
    sessionID: input.sessionID,
    logicalRequestID: input.logicalRequestID,
    attemptID: input.attemptID,
    retryOf: input.retryOf ?? null,
    goalID: input.assignment?.goalID ?? null,
    taskID: input.assignment?.taskID ?? null,
    role: input.assignment?.role ?? null,
    attribution: input.assignment ? "assignment" : "unknown",
    phase: input.phase,
    providerID: input.providerID,
    modelID: input.modelID,
    startedAt: input.startedAt,
    endedAt: null,
    durationMs: null,
    outcome: "unknown",
    usage: unknownUsage,
    cost: unknownCost,
    toolCount: input.toolCount,
    messageCount: input.messageCount,
    estimates: {
      system: input.estimates?.system ?? null,
      tools: input.estimates?.tools ?? null,
      history: input.estimates?.history ?? null,
      method: input.estimates?.method ?? "none",
    },
    sdkRetries: "uncounted",
  }
  return { attempts: { ...ledger.attempts, [input.attemptID]: opened } }
}

/** Terminal and idempotent: a duplicate finish returns the ledger unchanged, never a second record. */
export function finish(ledger: Ledger, attemptID: string, input: FinishInput): Ledger {
  const current = ledger.attempts[attemptID]
  if (!current || current.outcome !== "unknown") return ledger
  return {
    attempts: {
      ...ledger.attempts,
      [attemptID]: {
        ...current,
        endedAt: input.endedAt,
        durationMs: input.endedAt - current.startedAt,
        outcome: input.outcome,
        usage: input.usage ?? current.usage,
        cost: input.cost ?? current.cost,
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
