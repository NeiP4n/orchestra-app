export * as SkillMarketplaceResolve from "./resolve.js"

import { highestSatisfying } from "./manifest.js"
import type { Adapter, JournalEntry, Level, Manifest, Port, PortType } from "./types.js"

/**
 * Mismatches are settled HERE, at install and factory-build time — never
 * while a skill is running. Every settlement is a journal entry that says
 * what did not match and what was decided, so a later reader can see why
 * the factory looks the way it does instead of guessing.
 *
 * Priority, everywhere: society > project > session. A higher level wins; a
 * lower level never silently overrides it.
 */

export interface IoResolution {
  /** True when the value can flow from the source port into the target port. */
  readonly ok: boolean
  /** The conversion to insert, when the types differ but convert. */
  readonly adapter: Adapter | undefined
  /** Why it cannot flow, when `ok` is false. */
  readonly reason: string | undefined
}

/**
 * Conversions the factory may insert between two ports. The list is closed
 * on purpose: a conversion the factory cannot name is a mismatch, not a
 * guess. `code` never converts implicitly — code is never silently
 * reinterpreted as text, json, or anything else.
 */
const ADAPTERS: readonly Adapter[] = [
  { from: "json", to: "text", how: "Stringify the JSON value." },
  { from: "text", to: "json", how: "Parse the text as JSON; fail the step when it is not valid JSON." },
  { from: "list", to: "text", how: "Join the items with newlines." },
  { from: "text", to: "list", how: "Split the text on newlines and drop empty lines." },
  { from: "plan", to: "text", how: "Render the plan as numbered steps." },
  { from: "report", to: "text", how: "Use the report body as plain text." },
  { from: "text", to: "plan", how: "Read the text as a numbered list of steps." },
  { from: "text", to: "report", how: "Wrap the text as the report body." },
  { from: "file", to: "text", how: "Read the file as text." },
  { from: "json", to: "list", how: "Take the array from the JSON value; fail the step when it is not an array." },
  { from: "list", to: "json", how: "Encode the list as a JSON array." },
]

/** Can a value flow from `source` into `target`? Same name and type flows as-is. */
export const resolveIo = (source: Port, target: Port): IoResolution => {
  if (source.name !== target.name)
    return { ok: false, adapter: undefined, reason: `port "${source.name}" does not feed port "${target.name}".` }
  if (source.type === target.type) return { ok: true, adapter: undefined, reason: undefined }
  const adapter = ADAPTERS.find((entry) => entry.from === source.type && entry.to === target.type)
  if (adapter === undefined)
    return {
      ok: false,
      adapter: undefined,
      reason: `port "${source.name}" is ${source.type} and cannot become ${target.type}; no conversion exists.`,
    }
  return { ok: true, adapter, reason: undefined }
}

export type VersionResolution =
  | { readonly ok: true; readonly chosen: string; readonly journal: JournalEntry }
  | { readonly ok: false; readonly reason: string; readonly journal: JournalEntry }

/**
 * Settles a dependency's version range against the versions available.
 * Picks the highest version that satisfies the range; when none does, the
 * settlement is a refusal with the available versions named, never a silent
 * downgrade to something the range forbids.
 */
export const resolveVersion = (
  dependency: { name: string; range: string },
  available: readonly string[],
  at: number,
): VersionResolution => {
  const chosen = highestSatisfying(available, dependency.range)
  if (chosen !== undefined)
    return {
      ok: true,
      chosen,
      journal: {
        at,
        kind: "version",
        skill: dependency.name,
        level: undefined,
        problem: `${dependency.name} requires ${dependency.range}; available: ${available.join(", ") || "none"}.`,
        decision: `Use version ${chosen}.`,
      },
    }
  return {
    ok: false,
    reason: `No version of ${dependency.name} satisfies ${dependency.range} (available: ${available.join(", ") || "none"}).`,
    journal: {
      at,
      kind: "version",
      skill: dependency.name,
      level: undefined,
      problem: `${dependency.name} requires ${dependency.range}; available: ${available.join(", ") || "none"}.`,
      decision: "Refused: no compatible version exists.",
    },
  }
}

export type RuleResolution =
  | { readonly ok: true; readonly dropped: readonly string[]; readonly journal: JournalEntry | undefined }
  | { readonly ok: false; readonly reason: string; readonly journal: JournalEntry }

/**
 * A scope rule the skill's own rule contradicts, by level. Society rules are
 * hard: a skill that contradicts one is refused at install. A project or
 * session rule is softer: the scope rule wins, the skill's rule is dropped,
 * and the decision is journaled — the skill still installs, minus the rule
 * it cannot keep.
 *
 * Contradiction is deliberately narrow: an exact duplicate is not a
 * contradiction (it is deduped), and only a clear negation counts — one side
 * says "never X" or "do not X" while the other says "always X" or "X".
 * Anything subtler is not a contradiction this check can prove, and it does
 * not pretend otherwise.
 */
export const resolveRules = (
  skill: Manifest,
  scopeRules: ReadonlyArray<{ text: string; level: Level }>,
  at: number,
): RuleResolution => {
  const dropped: string[] = []
  for (const rule of skill.rules) {
    for (const scope of scopeRules) {
      if (sameRule(rule, scope.text)) continue
      if (!contradicts(rule, scope.text)) continue
      if (scope.level === "society")
        return {
          ok: false,
          reason: `Skill "${skill.name}" contradicts a society rule: "${scope.text}". A society rule cannot be overridden.`,
          journal: {
            at,
            kind: "rule",
            skill: skill.name,
            level: "society",
            problem: `Skill rule "${rule}" contradicts society rule "${scope.text}".`,
            decision: `Refused at install: society rules are hard.`,
          },
        }
      dropped.push(rule)
    }
  }
  const unique = [...new Set(dropped)]
  if (unique.length === 0) return { ok: true, dropped: [], journal: undefined }
  return {
    ok: true,
    dropped: unique,
    journal: {
      at,
      kind: "rule",
      skill: skill.name,
      level: undefined,
      problem: `Skill rules contradict scope rules: ${unique.map((rule) => `"${rule}"`).join(", ")}.`,
      decision: `Installed without the contradicted rules; the scope rules win.`,
    },
  }
}

const normalize = (text: string) => text.toLowerCase().replace(/\s+/g, " ").trim()

const sameRule = (a: string, b: string) => normalize(a) === normalize(b)

/**
 * A rule's polarity: "never X" / "do not X" is negative, "always X" and a
 * plain "X" are positive. Two rules contradict when they share a base with
 * opposite polarity — "never cite sources" against "always cite sources".
 * Two negatives ("never X" vs "do not X") agree; they do not contradict.
 */
const polarity = (text: string): { base: string; negative: boolean } => {
  const clean = normalize(text).replace(/[.!?]$/, "")
  for (const prefix of ["never ", "do not ", "don't ", "dont "]) {
    if (clean.startsWith(prefix)) return { base: clean.slice(prefix.length), negative: true }
  }
  if (clean.startsWith("always ")) return { base: clean.slice("always ".length), negative: false }
  return { base: clean, negative: false }
}

const contradicts = (a: string, b: string) => {
  const pa = polarity(a)
  const pb = polarity(b)
  return pa.base === pb.base && pa.negative !== pb.negative
}

/** Ports of one type, for the factory's adapter search. */
export const adapterFor = (from: PortType, to: PortType): Adapter | undefined =>
  ADAPTERS.find((entry) => entry.from === from && entry.to === to)
