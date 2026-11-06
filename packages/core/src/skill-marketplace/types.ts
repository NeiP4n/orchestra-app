export * as SkillMarketplaceTypes from "./types.js"

/**
 * Shared types for the NATIVE skill marketplace: the part of
 * `packages/core/src/skill-marketplace/` that lives inside Orchestra (no
 * external catalog), with three levels, a factory that composes skills into a
 * working pipeline, mismatch resolution at install/build time, and a hard
 * token budget.
 *
 * A skill is never its full text here. The compact index carries only what a
 * search needs (name, purpose, ports, version, level); the full SKILL.md is
 * read lazily, only for the skill a task actually uses, and only while the
 * token budget allows it. That is the whole anti-overload mechanism.
 */

/** Where a skill lives. Lower levels inherit the ones above them. */
export type Level = "society" | "project" | "session"

/** The three levels, highest first: a higher level wins every conflict. */
export const LEVELS: readonly Level[] = ["society", "project", "session"]

/** The small closed set of port types a skill's inputs and outputs may use. */
export type PortType = "text" | "json" | "list" | "file" | "code" | "plan" | "report"

export const PORT_TYPES: readonly PortType[] = ["text", "json", "list", "file", "code", "plan", "report"]

/** One named input or output of a skill. */
export interface Port {
  readonly name: string
  readonly type: PortType
}

/** One dependency of a skill: a skill name plus a version range. */
export interface Dependency {
  readonly name: string
  /** A range like `^1.2.0`, `>=1.0.0 <2.0.0`, `1.2.3`, or `*`. */
  readonly range: string
}

/**
 * The manifest of a native skill: what it does, what it needs, what it
 * produces, what it depends on, and which rules it brings. Parsed from the
 * YAML frontmatter of a SKILL.md (see `manifest.ts`); a skill without one
 * gets a derived manifest with no ports, which means it can run alone but
 * can never be chained into a factory.
 */
export interface Manifest {
  readonly name: string
  /** Semver, e.g. `1.2.0`. A derived manifest carries `0.0.0`. */
  readonly version: string
  /** One or two sentences: what this skill is for. */
  readonly purpose: string
  readonly inputs: readonly Port[]
  readonly outputs: readonly Port[]
  readonly depends: readonly Dependency[]
  /** Rules the skill itself declares; scope rules outrank them (see `resolve.ts`). */
  readonly rules: readonly string[]
  /** True when the manifest was derived from the text, not written by hand. */
  readonly derived: boolean
}

/**
 * An installed native skill. `contentPath` points at the SKILL.md file; the
 * text itself is never stored here and is read only by lazy load.
 */
export interface NativeSkill {
  readonly manifest: Manifest
  readonly level: Level
  /** Where the skill came from: a catalog row id, `local`, or `builtin`. */
  readonly source: string
  /** Absolute path of the SKILL.md file. */
  readonly contentPath: string
}

/**
 * One row of the compact index: everything a search needs, nothing it does
 * not. This — never the full skill text — is what enters an agent's context
 * when it looks for a skill.
 */
export interface SkillRef {
  readonly name: string
  readonly purpose: string
  readonly version: string
  readonly level: Level
  readonly inputs: readonly Port[]
  readonly outputs: readonly Port[]
}

/** One step of a conversion between two port types. */
export interface Adapter {
  readonly from: PortType
  readonly to: PortType
  /** How the value is converted, in words an agent can follow. */
  readonly how: string
}

/** One step of a composed factory: which skill runs, and where its inputs come from. */
export interface FactoryStep {
  readonly skill: string
  readonly level: Level
  /** `task` = the caller's own input, `skill:<name>` = an earlier step, `adapter:<from>-><to>` = a conversion. */
  readonly inputs: readonly { readonly port: Port; readonly from: string }[]
  readonly outputs: readonly Port[]
}

/** A working production line: ordered steps that turn the task's inputs into the goal's outputs. */
export interface Factory {
  readonly steps: readonly FactoryStep[]
  /** Adapters the composition inserted, in order. */
  readonly adapters: readonly Adapter[]
}

/** What did not match, and how it was settled. Every entry is explainable. */
export interface JournalEntry {
  readonly at: number
  readonly kind: "io" | "version" | "rule" | "install" | "factory" | "usage" | "budget"
  readonly skill: string | undefined
  readonly level: Level | undefined
  /** What did not match, in plain words. */
  readonly problem: string
  /** What was decided, in plain words. */
  readonly decision: string
}

/** One use of a skill, recorded so the rules it followed are not lost between runs. */
export interface Usage {
  readonly skill: string
  readonly level: Level
  readonly task: string
  readonly outcome: "done" | "failed" | "refused"
  readonly tokens: number
  readonly at: number
}

/**
 * The verdict of prompt-intake's value checker, as the marketplace receives
 * it. The marketplace does not judge value itself: prompt-intake owns that,
 * and this is the interface it passes in. `proceed: false` means the request
 * is a duplicate, redundant, or low-value — the marketplace then does no
 * search and loads nothing. It maps to prompt-intake's own `ValueAssessment`
 * (`packages/core/src/prompt-intake/types.ts`) as `proceed = verdict ===
 * "execute"`, `reason = reasons.join(" ")` — the other verdicts (`clarify`,
 * `merge`, `skip`) all mean "do not search".
 */
export interface ValueVerdict {
  readonly proceed: boolean
  readonly reason: string | undefined
}
