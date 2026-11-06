export * as PromptIntakeSkills from "./skills.js"

import { stem, tokens } from "./normalize.js"
import type { ValueVerdict } from "../skill-marketplace/types.js"
import type { SkillRecommendation, StructuredTask, ValueAssessment } from "./types.js"

/**
 * Bridges prompt-intake's value verdict to the native skill marketplace:
 * the marketplace only searches and loads skills when the value checker
 * says the prompt should execute. A refusal (clarify/merge/skip) means
 * no search and no load — pass this verdict to pickSkillsForTask.
 */
export function valueVerdictForMarketplace(assessment: ValueAssessment): ValueVerdict {
  return {
    proceed: assessment.verdict === "execute",
    reason: assessment.reasons.join(" ") || undefined,
  }
}

// Russian task-word stems mapped to the English words skill names and
// content use. Keys are stems (so "документацию" and "документация" both
// hit), values are stemmed too before matching.
const DOMAIN_ALIASES: Readonly<Record<string, ReadonlyArray<string>>> = {
  тест: ["test"],
  документаци: ["doc", "docs", "documentation"],
  гит: ["git"],
  коммит: ["git", "commit"],
  ревью: ["review"],
  проверк: ["review", "check"],
  исследовани: ["research"],
  поиск: ["search"],
  браузер: ["browser", "playwright"],
  стол: ["desktop"],
  экран: ["desktop"],
  баз: ["database", "db"],
  данн: ["database", "data"],
  депло: ["deploy", "release"],
  релиз: ["release", "deploy"],
  сборк: ["build"],
  ошибк: ["debug", "error"],
  баг: ["debug", "bug"],
  безопасност: ["security"],
  производител: ["performance"],
  скорост: ["performance"],
}

export type SkillRef = {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly content: string
}

function expandKeywords(keywords: ReadonlyArray<string>): ReadonlyArray<{ original: string; forms: ReadonlyArray<string> }> {
  return keywords.map((word) => {
    const wordStem = stem(word)
    return {
      original: word,
      forms: Array.from(new Set([wordStem, ...(DOMAIN_ALIASES[wordStem] ?? []).map((alias) => stem(alias))])),
    }
  })
}

/**
 * Recommends skills for EXECUTING the task. This module does not replace
 * skills: it only reads the task and says which skills the agent should
 * load. Matching is keyword-stem overlap against name, description and the
 * head of the skill content — cheap, no model. The reason names the
 * original task words that matched, not the internal aliases.
 */
export function recommendSkills(
  task: StructuredTask,
  skills: ReadonlyArray<SkillRef>,
): ReadonlyArray<SkillRecommendation> {
  const wanted = expandKeywords(task.keywords)
  if (wanted.length === 0 || skills.length === 0) return []
  const scored = skills
    .map((skill) => {
      const haystack = new Set(tokens(`${skill.name} ${skill.description ?? ""} ${skill.content.slice(0, 800)}`).map((token) => stem(token)))
      const matched = wanted.filter((entry) => entry.forms.some((form) => haystack.has(form)))
      const nameHit = wanted.some((entry) => entry.forms.some((form) => stem(skill.name).includes(form)))
      const score = matched.length / wanted.length + (nameHit ? 0.15 : 0)
      return { skill, matched, score }
    })
    .filter((entry) => entry.score >= 0.2)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
  return scored.map((entry) => ({
    id: entry.skill.id,
    name: entry.skill.name,
    reason: `Совпали ключевые слова: ${entry.matched.map((match) => match.original).join(", ")}`,
    score: Math.min(1, entry.score),
  }))
}
