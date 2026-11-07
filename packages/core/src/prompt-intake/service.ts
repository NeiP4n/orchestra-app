export * as PromptIntake from "./service.js"

import { makeLocationNode } from "@orchestra/util/effect/app-node"
import { Context, Effect, Layer, Option } from "effect"
import type { SessionSchema } from "../session/schema.js"
import { Skill } from "../skill.js"
import type { Disambiguator } from "./model.js"
import { recommendSkills, valueVerdictForMarketplace, type SkillRef } from "./skills.js"
import { dispositionFor } from "./policy.js"
import { isContinuation } from "./normalize.js"
import type {
  Disambiguation,
  IntakeContext,
  IntakeResult,
  SkillRecommendation,
  StructuredTask,
  ValueAssessment,
} from "./types.js"
import { understand } from "./understand.js"
import { checkValue } from "./value.js"

export interface Interface {
  /**
   * Deep-process one incoming prompt: value check first (so tokens are
   * never spent on duplicates or finished work), then the heuristic
   * structured task, then an optional cheap-model disambiguation, then
   * skill recommendations. Never fails: on any internal error the raw
   * prompt passes through with a heuristic-only result.
   */
  readonly process: (input: {
    session: SessionSchema.Info
    text: string
    context: IntakeContext
    disambiguate?: Disambiguator
  }) => Effect.Effect<IntakeResult, never>
}

export class Service extends Context.Service<Service, Interface>()("@orchestra/PromptIntake") {}

const VERDICT_RU: Record<ValueAssessment["verdict"], string> = {
  execute: "выполнять",
  clarify: "уточнить у пользователя",
  merge: "слить с существующей задачей",
  skip: "пропустить",
}

// A model "clarification" is not allowed to replace the user's goal with an
// unbounded blob of text (m-09): the clarified goal is used only when it is a
// real, short goal; anything empty or longer than a sentence is dropped and
// the heuristic goal stands. Assumptions are advisory text, so an overlong
// one is truncated instead of dropped.
const MAX_CLARIFIED_GOAL_CHARS = 500
const MAX_ASSUMPTION_CHARS = 500

function applyDisambiguation(task: StructuredTask, disambiguation: Disambiguation): StructuredTask {
  const clarifiedGoal = disambiguation.clarifiedGoal?.trim()
  const goal =
    clarifiedGoal !== undefined && clarifiedGoal !== "" && clarifiedGoal.length <= MAX_CLARIFIED_GOAL_CHARS
      ? clarifiedGoal
      : task.goal
  return {
    ...task,
    goal,
    ambiguities: task.ambiguities.map((ambiguity, index) => {
      const assumption = disambiguation.assumptions[index]?.trim()
      return {
        ...ambiguity,
        assumption:
          assumption !== undefined && assumption !== ""
            ? assumption.slice(0, MAX_ASSUMPTION_CHARS)
            : ambiguity.assumption,
      }
    }),
  }
}

function buildEnrichedPrompt(
  original: string,
  value: ValueAssessment,
  task: StructuredTask,
  skills: ReadonlyArray<SkillRecommendation>,
): string {
  const sections: Array<string> = [original.trim(), "", "---", "[PromptIntake — структурированная задача]"]
  sections.push(`Цель: ${task.goal}`)
  if (task.context.length > 0) {
    sections.push("Контекст:")
    for (const line of task.context) sections.push(`- ${line}`)
  }
  if (task.constraints.length > 0) {
    sections.push("Ограничения:")
    for (const line of task.constraints) sections.push(`- ${line}`)
  }
  sections.push("Готово, когда:")
  for (const line of task.dod) sections.push(`- ${line}`)
  sections.push("План:")
  task.plan.forEach((step, index) => sections.push(`${index + 1}. ${step}`))
  if (task.ambiguities.length > 0) {
    sections.push("Вопросы к пользователю (если не ответит — действуй по допущениям):")
    for (const ambiguity of task.ambiguities) {
      sections.push(`- ${ambiguity.question} (допущение: ${ambiguity.assumption})`)
    }
  }
  if (skills.length > 0) {
    sections.push(`Рекомендуемые скиллы: ${skills.map((skill) => `${skill.name} (${skill.reason})`).join("; ")}`)
  }
  sections.push(`Ценность: ${VERDICT_RU[value.verdict]} — ${value.reasons.join(" ")}`)
  for (const evidence of value.evidence) {
    sections.push(`Ссылка: ${evidence.title} (${evidence.kind}, совпадение ${Math.round(evidence.score * 100)}%)`)
  }
  return sections.join("\n")
}

/**
 * The pure pipeline (no model, no services): value check, heuristic
 * structured task, skill recommendations from a given skill list. Used by
 * the service and by callers that have no service in scope.
 */
export function processPure(input: {
  text: string
  context: IntakeContext
  skills?: ReadonlyArray<SkillRef>
}): IntakeResult {
  if (isContinuation(input.text)) {
    const value = checkValue(input.text, input.context)
    return {
      original: input.text,
      value,
      valueVerdict: valueVerdictForMarketplace(value),
      task: understand(input.text, input.context),
      skills: [],
      enrichedPrompt: input.text,
      modelUsed: false,
      disposition: dispositionFor(value, input.text),
    }
  }
  const value = checkValue(input.text, input.context)
  const task = understand(input.text, input.context)
  const recommended = recommendSkills(task, input.skills ?? [])
  return {
    original: input.text,
    value,
    valueVerdict: valueVerdictForMarketplace(value),
    task,
    skills: recommended,
    enrichedPrompt: buildEnrichedPrompt(input.text, value, task, recommended),
    modelUsed: false,
    disposition: dispositionFor(value, input.text),
  }
}

export const process = Effect.fn("PromptIntake.process")(function* (input: {
  session: SessionSchema.Info
  text: string
  context: IntakeContext
  disambiguate?: Disambiguator
}): Effect.Effect<IntakeResult, never> {
  if (isContinuation(input.text)) {
    const value = checkValue(input.text, input.context)
    return {
      original: input.text,
      value,
      valueVerdict: valueVerdictForMarketplace(value),
      task: understand(input.text, input.context),
      skills: [],
      enrichedPrompt: input.text,
      modelUsed: false,
      disposition: dispositionFor(value, input.text),
    }
  }
  const value = checkValue(input.text, input.context)
  let task = understand(input.text, input.context)
  let modelUsed = false
  if (task.needsModel && (value.verdict === "execute" || value.verdict === "clarify") && input.disambiguate) {
    const disambiguation = yield* input.disambiguate({ session: input.session, task })
    if (disambiguation.modelUsed) {
      task = applyDisambiguation(task, disambiguation)
      modelUsed = true
    }
  }
  const skillService = yield* Effect.serviceOption(Skill.Service)
  const installed = Option.isSome(skillService)
    ? yield* skillService.value.list().pipe(Effect.orElseSucceed(() => [] as Array<Skill.Info>))
    : []
  const recommended = recommendSkills(task, installed)
  return {
    original: input.text,
    value,
    valueVerdict: valueVerdictForMarketplace(value),
    task,
    skills: recommended,
    enrichedPrompt: buildEnrichedPrompt(input.text, value, task, recommended),
    modelUsed,
    disposition: dispositionFor(value, input.text),
  }
})

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    return Service.of({ process })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [],
})
