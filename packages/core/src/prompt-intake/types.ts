export * as PromptIntakeTypes from "./types.js"

/** What the value check decided about a prompt. */
export type Verdict = "execute" | "clarify" | "merge" | "skip"

export type EvidenceKind = "dod-open" | "dod-done" | "session-history" | "autoloop-journal"

export type Evidence = {
  readonly kind: EvidenceKind
  /** ID of the task, message, or journal entry this points at. */
  readonly ref: string
  /** Human-readable title of the thing this points at. */
  readonly title: string
  /** Similarity between the prompt and the evidence, 0..1. */
  readonly score: number
}

export type ValueAssessment = {
  readonly verdict: Verdict
  /** How sure the checker is, 0..1. Heuristic verdicts never claim 1. */
  readonly confidence: number
  /** Plain-language reasons, in order of importance. */
  readonly reasons: ReadonlyArray<string>
  /** What the verdict is based on; empty when there is nothing to point at. */
  readonly evidence: ReadonlyArray<Evidence>
  /** 0..3 questions for the user; only filled when the verdict is "clarify". */
  readonly questions: ReadonlyArray<string>
  /** Which sources were actually consulted (a missing source is never treated as "no match"). */
  readonly sources: {
    readonly dod: boolean
    readonly history: boolean
    readonly journal: boolean
  }
}

export type Ambiguity = {
  /** The question to ask the user (or the agent, when it can decide itself). */
  readonly question: string
  /** The default reading the agent should use when the user does not answer. */
  readonly assumption: string
}

export type StructuredTask = {
  readonly goal: string
  readonly context: ReadonlyArray<string>
  readonly constraints: ReadonlyArray<string>
  /** How to tell the work is done; plain sentences, not a checklist format. */
  readonly dod: ReadonlyArray<string>
  readonly ambiguities: ReadonlyArray<Ambiguity>
  readonly plan: ReadonlyArray<string>
  readonly keywords: ReadonlyArray<string>
  /** True when the heuristic reading is too uncertain to trust without a model pass. */
  readonly needsModel: boolean
}

export type SkillRecommendation = {
  readonly id: string
  readonly name: string
  readonly reason: string
  /** Keyword overlap between the task and the skill, 0..1. */
  readonly score: number
}

export type DodItemRef = {
  readonly id: string
  readonly title: string
  /** Free-form state ("open", "done", "in-progress", ...); matched loosely. */
  readonly state: string
}

export type RecentPromptRef = {
  readonly text: string
  readonly outcome?: string
}

export type JournalRef = {
  readonly title: string
  readonly outcome?: string
}

/**
 * What the value checker compares a prompt against. The caller supplies
 * whatever it can reach; `sources` says which parts are real. A source
 * that is missing is reported, never silently treated as "no match".
 */
export type IntakeContext = {
  readonly dodItems: ReadonlyArray<DodItemRef>
  readonly recentPrompts: ReadonlyArray<RecentPromptRef>
  readonly journalTitles: ReadonlyArray<JournalRef>
  /** Keywords describing the project, for out-of-scope detection; empty means "not assessed". */
  readonly projectScope?: ReadonlyArray<string>
  readonly sources: {
    readonly dod: boolean
    readonly history: boolean
    readonly journal: boolean
  }
}

export type IntakeResult = {
  readonly original: string
  readonly value: ValueAssessment
  readonly task: StructuredTask
  readonly skills: ReadonlyArray<SkillRecommendation>
  /** Original prompt verbatim, followed by the structured interpretation the agent receives. */
  readonly enrichedPrompt: string
  readonly modelUsed: boolean
}

/** What a model disambiguation returns; the heuristic reading is the fallback. */
export type Disambiguation = {
  readonly assumptions: ReadonlyArray<string>
  readonly clarifiedGoal?: string
  /** True when a model actually answered; false when this is the heuristic fallback. */
  readonly modelUsed: boolean
}
