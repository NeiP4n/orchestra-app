export * as QuestionTool from "./question.js"

import type { Context } from "@orchestra/plugin/effect/plugin"
import { ToolFailure } from "@orchestra/ai"
import { Effect, Schema } from "effect"
import { Form } from "../../form.js"
import { FormDecision } from "../../form-decision.js"
import { Permission } from "../../permission.js"
import { Question } from "@orchestra/schema/question"
import { AutoDecide } from "./auto-decide.js"

export const name = "question"

export const description = `Use this tool only when you need something that only the user can give: approval to spend money, a secret or credential, or approval to publish or do another irreversible action on their behalf.
Do not use it to ask how to solve the task, which implementation or direction to choose, or whether to start: decide, state the assumption in one line and do the work.

Usage notes:
- A "Type your own answer" option is added automatically; don't include a separate option for free form answers
- Set \`multiple: true\` to allow selecting more than one option
- If you recommend a specific option, make that the first option in the list and add "(Recommended)" at the end of the label`

export const Input = Schema.Struct({
  questions: Schema.Array(Question.Prompt).check(Schema.isNonEmpty()).annotate({ description: "Questions to ask" }),
})

export const Output = Schema.Struct({
  answers: Schema.Array(Question.Answer),
})
export type Output = typeof Output.Type

export class CancelledError extends Schema.TaggedError<CancelledError>()("QuestionTool.CancelledError", {}) {
  override get message() {
    return "The user dismissed this question"
  }
}

export const toModelContent = (questions: ReadonlyArray<Question.Prompt>, answers: ReadonlyArray<Question.Answer>) => {
  const formatted = questions
    .map(
      (question, index) =>
        `"${question.question}"="${answers[index]?.length ? answers[index].join(", ") : "Unanswered"}"`,
    )
    .join(", ")
  return `User has answered your questions: ${formatted}. You can now continue with the user's answers in mind.`
}

export const Plugin = {
  id: "orchestra.tool.question",
  effect: Effect.fn("QuestionTool.Plugin")(function* (ctx: Context) {
    const forms = yield* Form.Service
    const permission = yield* Permission.Service

    yield* ctx.tool
      .transform((editor) =>
        editor.add({
          name,
          options: { codemode: false, core: true },
          description,
          input: Input,
          output: Output,
          execute: (input, context) =>
            AutoDecide.active.pipe(Effect.flatMap((auto) => {
              const fields = input.questions.map((question, index) => toField(question, index))
              const choosable = fields.every((field) => "options" in field && (field.options?.length ?? 0) > 0)
              const touchy = input.questions.some((question) =>
                AutoDecide.sensitive(question.question, question.header, ...question.options.flatMap((o) => [o.label, o.description])),
              )
              if (!auto || touchy) return Effect.succeed(undefined)
              if (!choosable)
                return Effect.fail(
                  new ToolFailure({
                    message:
                      "Auto mode: do not ask the user how to solve the task. Choose yourself, state the assumption in one line and continue. Only money, secrets or publishing in their name go to the user.",
                  }),
                )
              const answers = fields.map((field): Question.Answer => {
                const labels = (field.options ?? []).map((option) => option.label)
                return [labels[AutoDecide.pick(labels)]!]
              })
              return Effect.succeed({
                output: { answers },
                content: toModelContent(input.questions, answers),
                metadata: { answers, answeredBy: { by: "Orchestrator (auto)", reason: AutoDecide.REASON } },
              })
            })).pipe(Effect.flatMap((auto) => auto !== undefined ? Effect.succeed(auto) :
            permission
              .assert({
                action: "question",
                resources: ["*"],
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.messageID, id: context.id },
              })
              .pipe(
                Effect.mapError((error) => new ToolFailure({ message: "Permission denied: question", error })),
                Effect.andThen(
                  forms
                    .ask({
                      sessionID: context.sessionID,
                      title: "Questions",
                      metadata: {
                        kind: "question",
                        tool: { messageID: context.messageID, id: context.id },
                      },
                      fields: [
                        toField(input.questions[0], 0),
                        ...input.questions.slice(1).map((question, index) => toField(question, index + 1)),
                      ],
                    })
                    .pipe(Effect.orDie),
                ),
                Effect.flatMap((state) => {
                  // Deliberate defect tunnel (see Permission.assert): a dismissal must dodge
                  // leaf `mapError` blankets so it never becomes model-facing tool output; it
                  // resurfaces as a typed failure at SessionModelRequest.executeTool.
                  // A dismissal with a message (e.g. from a non-interactive client) is ordinary
                  // model-facing feedback: the model continues instead of the step ending.
                  if (state.status === "cancelled" && state.message !== undefined)
                    return Effect.fail(new ToolFailure({ message: state.message }))
                  if (state.status === "cancelled") return Effect.die(new CancelledError())
                  const output = {
                    answers: input.questions.map((_, index): Question.Answer => {
                      const value = state.answer[`q${index}`]
                      if (value === undefined) return []
                      if (typeof value === "object") return Array.from(value)
                      return [String(value)]
                    }),
                  }
                  const decided = FormDecision.take(FormDecision.key(context.messageID, context.id))
                  return Effect.succeed({
                    output,
                    content: toModelContent(input.questions, output.answers),
                    metadata: { answers: output.answers, ...(decided ? { answeredBy: decided } : {}) },
                  })
                }),
              ))),
        }),
      )
      .pipe(Effect.orDie)
  }),
}

export function toField(question: Question.Prompt, index: number): Form.Field {
  const presets: Record<NonNullable<Question.Prompt["kind"]>, Question.Prompt["options"]> = {
    choice: [],
    "multi-select": [],
    text: [],
    "yes-no": [
      { label: "Yes", description: "Confirm and continue" },
      { label: "No", description: "Decline or stop" },
    ],
    priority: [
      { label: "Low", description: "Can wait; minimal urgency" },
      { label: "Normal", description: "Standard priority" },
      { label: "High", description: "Important; address soon" },
      { label: "Critical", description: "Urgent; address first" },
    ],
    rating: [1, 2, 3, 4, 5].map((value) => ({
      label: String(value),
      description: ["Very poor", "Poor", "Average", "Good", "Excellent"][value - 1],
    })),
  }
  const kind = question.kind ?? (question.multiple ? "multi-select" : "choice")
  const options = kind === "text" ? [] : question.options.length ? question.options : presets[kind]
  return {
    key: `q${index}`,
    title: question.header,
    description: question.question,
    type: kind === "multi-select" || question.multiple === true ? "multiselect" : "string",
    options: options.map((option) => ({
      value: option.label,
      label: option.label,
      description: option.description,
    })),
    custom: true,
  }
}
