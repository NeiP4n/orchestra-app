export * as SkillMarketplaceRules from "./rules.js"

import { SkillMarketplaceScan } from "./scan.js"
import { resolveRules } from "./resolve.js"
import type { JournalEntry, Level, Manifest } from "./types.js"

/**
 * Rules are what keep a skill honest. Two checks run at install, before a
 * skill can ever reach an agent:
 *
 * 1. The static scan (`scan.ts`, SkillSpector-style): a skill whose text
 *    scores DO NOT INSTALL is refused, with the findings named.
 * 2. The rule check (`resolve.ts`): a skill whose own rules contradict a
 *    society rule is refused — society rules are hard. A contradiction with
 *    a project or session rule drops the skill's rule instead; the scope
 *    rule wins and the decision is journaled.
 *
 * A skill that passes carries its rules with it: when its text is lazily
 * loaded, the scope rules that bind it are prepended as a short block, so
 * the agent sees the rules in the same breath as the skill. And every use
 * is recorded (see `levels.recordUsage`), so the rules a skill followed are
 * not lost between runs.
 */

export type Check =
  | { readonly ok: true; readonly droppedRules: readonly string[]; readonly journal: JournalEntry | undefined }
  | { readonly ok: false; readonly reason: string; readonly journal: JournalEntry }

/**
 * Decides whether a skill may be installed at a level, given the skill's
 * text and the scope rules that bind that level (society rules first).
 */
export const checkInstall = (
  manifest: Manifest,
  content: string,
  scopeRules: ReadonlyArray<{ text: string; level: Level }>,
): Check => {
  const report = SkillMarketplaceScan.scan(content)
  if (SkillMarketplaceScan.blocked(report)) {
    const reason = [
      `Skill "${manifest.name}" was refused at install: scan score ${report.score}/100, ${report.recommendation}.`,
      ...report.findings.map((finding) => `- ${finding.severity} ${finding.rule} line ${finding.line}: ${finding.message}`),
    ].join("\n")
    return {
      ok: false,
      reason,
      journal: {
        at: Date.now(),
        kind: "rule",
        skill: manifest.name,
        level: undefined,
        problem: `Skill "${manifest.name}" failed the static scan (${report.score}/100, ${report.recommendation}).`,
        decision: "Refused at install: the scan says DO NOT INSTALL.",
      },
    }
  }
  const rules = resolveRules(manifest, scopeRules, Date.now())
  if (!rules.ok) return { ok: false, reason: rules.reason, journal: rules.journal }
  return { ok: true, droppedRules: rules.dropped, journal: rules.journal ?? undefined }
}

/**
 * The block prepended to a skill's text when it is lazily loaded: the
 * skill's own purpose, the scope rules that bind it (highest level first),
 * and the one line that makes the priority explicit. Short on purpose — the
 * rules are already capped at 20 per scope and 240 characters each, so the
 * block stays small and the skill's own text is what costs the tokens.
 */
export const injectionBlock = (
  manifest: Manifest,
  scopeRules: ReadonlyArray<{ text: string; level: Level }>,
): string => {
  const lines = [`Skill "${manifest.name}" v${manifest.version}: ${manifest.purpose}`, ""]
  if (scopeRules.length > 0) {
    lines.push("Rules that bind this skill (society rules outrank project rules, which outrank session rules):")
    for (const rule of scopeRules) lines.push(`- [${rule.level}] ${rule.text}`)
    lines.push("")
  }
  if (manifest.rules.length > 0) {
    lines.push("Rules this skill declares:")
    for (const rule of manifest.rules) lines.push(`- ${rule}`)
    lines.push("")
  }
  return lines.join("\n")
}
