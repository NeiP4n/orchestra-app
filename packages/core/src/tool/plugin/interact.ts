export * as InteractTool from "./interact.js"

import type { Context } from "@orchestra/plugin/effect/plugin"
import { ToolFailure } from "@orchestra/ai"
import { Interactive } from "@orchestra/schema/interactive"
import { Effect, Schema } from "effect"
import { Form } from "../../form.js"
import { FormDecision } from "../../form-decision.js"
import { AutoDecide } from "./auto-decide.js"
import { Orchestra } from "../../orchestra.js"
import { Permission } from "../../permission.js"
import { Session } from "../../session.js"
import { CancelledError } from "./question.js"

export const name = "interact"

export const description = `Present structured interactive content inside the conversation and, for choices, wait for the person's answer.

Use this tool when a structured response materially improves the work:
- "decision": the person must choose between concrete options. Give each option its trade-offs (pros, cons, risks, consequences, cost) and mark the one you recommend. The person picks one (or several with multiple: true) or writes their own answer; you receive the actual selection.
- "comparison": compare models, libraries, architectures or strategies with attributes, strengths, weaknesses and optional ratings. The person can send one item back as their choice.
- "approval": ask the person to approve, reject or request changes to a specific proposed action BEFORE you do it. State exactly what will happen, its consequences and risks. An approval here is the person's decision about the proposal; it never replaces tool permissions for the action itself.
- "plan": show a structured plan (phases and tasks with statuses). In an Orchestra project the card shows the project's real workflow stages when they exist — never invent progress.
- "visualization": show data as a bar/line/pie chart, metric cards, a progress indicator or a table. Supply the actual values; nothing is estimated for you.

Do NOT use this tool for simple questions (use the question tool or plain text), for explanations that need no decision, or to turn every answer into a card. One block per call. Blocks are data only: no HTML, scripts or executable content, and links must be http(s).`

export const Input = Schema.Struct({
  block: Interactive.Block.annotate({ description: "The interactive block to present" }),
})

export const Output = Schema.Struct({
  type: Schema.Literals(["decision", "comparison", "approval", "plan", "visualization"]),
  response: Interactive.Response.pipe(Schema.optional).annotate({
    description: "The person's validated answer (decision, comparison and approval blocks)",
  }),
  source: Schema.Literals(["stages", "model"]).pipe(Schema.optional).annotate({
    description: "For plan blocks: whether the tasks came from the project's real stages or the model's snapshot",
  }),
})
export type Output = typeof Output.Type

/** Total serialized ceiling for one block, on top of the schema's per-field caps. */
export const MAX_BLOCK_BYTES = 32_768

const dangerousScheme = /^(javascript|data|file|vbscript):/i

/** Authoring rules the schema cannot express: unique ids, safe links, total size. */
export function validateBlock(block: Interactive.Block): string | undefined {
  if (JSON.stringify(block).length > MAX_BLOCK_BYTES) return `Interactive block is too large (over ${MAX_BLOCK_BYTES} bytes)`
  const ids = new Set<string>()
  const entries =
    block.type === "decision" ? block.options : block.type === "comparison" ? block.items : undefined
  for (const entry of entries ?? []) {
    if (ids.has(entry.id)) return `Duplicate option id in interactive block: ${entry.id}`
    ids.add(entry.id)
  }
  const texts: Array<string> = []
  const collect = (value: unknown) => {
    if (typeof value === "string") texts.push(value)
    else if (Array.isArray(value)) value.forEach(collect)
    else if (value && typeof value === "object") Object.values(value).forEach(collect)
  }
  collect(block)
  for (const value of texts) {
    // A string counts as a link when it carries an authority marker or a
    // scriptable scheme; ordinary prose with a colon ("Report: all green")
    // is not a link and stays allowed.
    const isLink = value.includes("://") || dangerousScheme.test(value)
    if (isLink && !value.startsWith("http://") && !value.startsWith("https://"))
      return `Only http(s) links are allowed in interactive blocks: ${value.slice(0, 80)}`
  }
}

function optionDescription(parts: {
  description?: string
  pros?: ReadonlyArray<string>
  cons?: ReadonlyArray<string>
  risks?: ReadonlyArray<string>
  consequences?: string
  cost?: string
}): string | undefined {
  const lines = [
    parts.description,
    parts.pros?.length ? `Pros: ${parts.pros.join("; ")}` : undefined,
    parts.cons?.length ? `Cons: ${parts.cons.join("; ")}` : undefined,
    parts.risks?.length ? `Risks: ${parts.risks.join("; ")}` : undefined,
    parts.consequences ? `Consequences: ${parts.consequences}` : undefined,
    parts.cost ? `Cost: ${parts.cost}` : undefined,
  ].filter(Boolean)
  return lines.length ? lines.join("\n") : undefined
}

/** The form fields a person answers for a decision, comparison or approval block. */
export function toFields(block: Interactive.Decision | Interactive.Comparison | Interactive.Approval): Form.Fields {
  const comment: Form.Field = { key: "comment", title: "Comment", type: "string", custom: true }
  if (block.type === "approval") {
    const decisionField: Form.Field = {
      key: "decision",
      title: "Decision",
      description: optionDescription({
        description: block.action,
        risks: block.risks,
        consequences: block.consequences?.join("; "),
      }),
      type: "string",
      options: [
        { value: "approved", label: "Approve", description: "Proceed with this action" },
        { value: "rejected", label: "Reject", description: "Do not proceed" },
        { value: "changes-requested", label: "Request changes", description: "Send it back with a comment" },
      ],
      custom: false,
      required: true,
    }
    return [decisionField, comment]
  }
  const entries =
    block.type === "decision"
      ? block.options.map((option) => ({
          value: option.id,
          label: option.recommended ? `${option.label} (Recommended)` : option.label,
          description: optionDescription(option),
        }))
      : block.items.map((item) => ({
          value: item.id,
          label: item.recommended ? `${item.name} (Recommended)` : item.name,
          description: optionDescription({
            description: item.summary,
            pros: item.strengths,
            cons: item.weaknesses,
            consequences: item.rating !== undefined ? `Rating: ${item.rating}/5` : undefined,
          }),
        }))
  const multiple = block.type === "decision" && block.multiple === true
  const choice: Form.Field = multiple
    ? {
        key: "choice",
        title: "Your choice",
        type: "multiselect",
        options: entries,
        custom: true,
        required: true,
      }
    : {
        key: "choice",
        title: block.type === "decision" ? "Your choice" : "Your pick",
        type: "string",
        options: entries,
        custom: true,
        required: true,
      }
  return [choice, comment]
}

/** Map a validated form answer back to the block's structured response. */
export function responseOf(
  block: Interactive.Decision | Interactive.Comparison | Interactive.Approval,
  answer: Form.Answer,
): Interactive.Response {
  const comment = typeof answer.comment === "string" && answer.comment.trim() ? answer.comment.trim() : undefined
  if (block.type === "approval") {
    const decision = answer.decision
    return {
      decision: decision === "approved" || decision === "rejected" || decision === "changes-requested" ? decision : "rejected",
      ...(comment ? { comment } : {}),
    }
  }
  const known = new Set(
    (block.type === "decision" ? block.options : block.items).map((entry) => entry.id),
  )
  const raw = answer.choice
  const values = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : []
  const selected = values.filter((value) => known.has(value))
  const custom = values.filter((value) => !known.has(value))
  const merged = [...custom, ...(comment ? [comment] : [])].join("\n")
  return {
    ...(selected.length ? { selected } : {}),
    ...(merged ? { comment: merged } : {}),
  }
}

function labelOf(block: Interactive.Decision | Interactive.Comparison, id: string) {
  if (block.type === "decision") return block.options.find((option) => option.id === id)?.label ?? id
  return block.items.find((item) => item.id === id)?.name ?? id
}

export function toModelContent(block: Interactive.Block, response?: Interactive.Response): string {
  if (block.type === "approval") {
    if (!response?.decision) return "The approval request ended without a decision."
    const words = { approved: "approved", rejected: "rejected", "changes-requested": "sent back with requested changes" } as const
    return `The user ${words[response.decision]} the proposed action "${block.title}".${response.comment ? ` Comment: ${response.comment}` : ""} Continue accordingly; tool permissions still apply to the action itself.`
  }
  if (block.type === "decision" || block.type === "comparison") {
    if (!response) return "The question ended without an answer."
    const chosen = (response.selected ?? []).map((id) => `"${labelOf(block, id)}"`).join(", ")
    return `The user answered "${block.title}": ${chosen || "no listed option"}${response.comment ? `. Their own words: ${response.comment}` : ""}. Continue with this answer in mind.`
  }
  return ""
}

/** Terminal-friendly rendering of a visualization: the fallback every client can show. */
export function renderVisualization(block: Interactive.Visualization): string {
  const chart = block.chart
  const lines = [block.title, ...(block.description ? [block.description] : [])]
  if (chart.kind === "metrics") {
    for (const metric of chart.metrics)
      lines.push(`${metric.label}: ${metric.value}${metric.detail ? ` (${metric.detail})` : ""}`)
    return lines.join("\n")
  }
  if (chart.kind === "progress") {
    const ratio = chart.max > 0 ? Math.min(1, Math.max(0, chart.value / chart.max)) : 0
    const filled = Math.round(ratio * 24)
    lines.push(`${chart.label}: [${"█".repeat(filled)}${"░".repeat(24 - filled)}] ${Math.round(ratio * 100)}% (${chart.value}/${chart.max})`)
    return lines.join("\n")
  }
  if (chart.kind === "table") {
    const widths = chart.columns.map((column, index) =>
      Math.max(column.length, ...chart.rows.map((row) => (row[index] ?? "").length)),
    )
    const render = (cells: ReadonlyArray<string>) => cells.map((cell, index) => cell.padEnd(widths[index])).join(" | ")
    lines.push(render(chart.columns), widths.map((width) => "-".repeat(width)).join("-+-"))
    for (const row of chart.rows) lines.push(render(row))
    return lines.join("\n")
  }
  for (const series of chart.series) {
    if (chart.series.length > 1) lines.push(`${series.name}:`)
    if (chart.kind === "bar") {
      const max = Math.max(...series.points.map((point) => point.value), 0)
      for (const point of series.points) {
        const width = max > 0 ? Math.round((Math.max(0, point.value) / max) * 24) : 0
        lines.push(`${point.label.padEnd(16)} ${"█".repeat(width)} ${point.value}`)
      }
    } else if (chart.kind === "pie") {
      const total = series.points.reduce((sum, point) => sum + Math.max(0, point.value), 0)
      for (const point of series.points)
        lines.push(`${point.label}: ${point.value}${total > 0 ? ` (${Math.round((Math.max(0, point.value) / total) * 100)}%)` : ""}`)
    } else {
      for (const point of series.points) lines.push(`${point.label}: ${point.value}`)
    }
  }
  return lines.join("\n")
}

export const Plugin = {
  id: "orchestra.tool.interact",
  effect: Effect.fn("InteractTool.Plugin")(function* (ctx: Context) {
    const forms = yield* Form.Service
    const permission = yield* Permission.Service
    const orchestra = yield* Orchestra.Service
    const sessions = yield* Session.Service

    yield* ctx.tool
      .transform((editor) =>
        editor.add({
          name,
          options: { codemode: false, core: true },
          description,
          input: Input,
          output: Output,
          execute: (input, context) =>
            Effect.gen(function* () {
              const block = input.block
              const invalid = validateBlock(block)
              if (invalid) return yield* new ToolFailure({ message: invalid })

              if (block.type === "plan") {
                // Prefer the project's real stage state over the model's snapshot:
                // a plan card must never invent progress.
                const session = yield* sessions.get(context.sessionID).pipe(Effect.orElseSucceed(() => undefined))
                const projectID =
                  Orchestra.sessionOwner(session?.metadata) ?? (yield* orchestra.mainOf(context.sessionID))?.id
                const stages = projectID ? yield* orchestra.stages(projectID) : []
                const effective: Interactive.Plan =
                  stages.length > 0
                    ? {
                        ...block,
                        phases: [
                          {
                            title: "Workflow stages",
                            tasks: stages.map((stage) => ({
                              title: stage.name,
                              status: stage.status,
                              ...(stage.result
                                ? { evidence: stage.result }
                                : stage.acceptance
                                  ? { detail: stage.acceptance }
                                  : {}),
                              ...(stage.roles[0] ? { agent: stage.roles[0] } : {}),
                            })),
                          },
                        ],
                      }
                    : block
                const tasks = effective.phases.flatMap((phase) => phase.tasks)
                const done = tasks.filter((task) => task.status === "completed").length
                return {
                  output: { type: "plan" as const, source: stages.length > 0 ? ("stages" as const) : ("model" as const) },
                  content: `Plan "${block.title}": ${done}/${tasks.length} tasks completed${stages.length > 0 ? " (live workflow stages)" : ""}. The plan card is shown in the conversation.`,
                  metadata: { interactiveBlock: effective },
                }
              }

              if (block.type === "visualization") {
                return {
                  output: { type: "visualization" as const },
                  content: renderVisualization(block),
                  metadata: { interactiveBlock: block },
                }
              }

              // In auto the Orchestrator picks the way to solve the task itself: a decision or comparison
              // takes the recommended entry (else the first) unless it touches money, secrets or publishing.
              // Approval blocks are never decided here.
              if (block.type === "decision" || block.type === "comparison") {
                const entries =
                  block.type === "decision"
                    ? block.options.map((o) => ({ id: o.id, label: o.label, recommended: o.recommended === true, text: [o.description, o.consequences, o.cost] }))
                    : block.items.map((i) => ({ id: i.id, label: i.name, recommended: i.recommended === true, text: [i.summary] }))
                if (
                  entries.length > 0 &&
                  (yield* AutoDecide.active) &&
                  !AutoDecide.sensitive(block.title, ...entries.flatMap((e) => [e.label, ...e.text]))
                ) {
                  const chosen = entries[AutoDecide.pick(entries.map((e) => e.label), entries.map((e) => e.recommended))]!
                  const response: Interactive.Response = { selected: [chosen.id] }
                  return {
                    output: { type: block.type, response },
                    content: toModelContent(block, response),
                    metadata: {
                      interactiveBlock: block,
                      interactiveResponse: response,
                      answeredBy: { by: "Orchestrator (auto)", reason: AutoDecide.REASON },
                    },
                  }
                }
              }

              // Decision, comparison and approval blocks are answered by the
              // person through the existing form channel: same validation,
              // same pending-form recovery, same team-question delegation.
              const state = yield* permission
                .assert({
                  action: "question",
                  resources: ["*"],
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source: { type: "tool", messageID: context.messageID, id: context.id },
                })
                .pipe(
                  Effect.mapError((error) => new ToolFailure({ message: "Permission denied: interact", error })),
                  Effect.andThen(
                    forms
                      .ask({
                        sessionID: context.sessionID,
                        title: block.title,
                        metadata: {
                          kind: "interactive",
                          block,
                          tool: { messageID: context.messageID, id: context.id },
                        },
                        fields: toFields(block),
                      })
                      .pipe(Effect.orDie),
                  ),
                )
              // Same dismissal semantics as the question tool (see its comment):
              // a dismissal with a message is model-facing feedback; a bare
              // dismissal ends the step as a typed cancellation.
              if (state.status === "cancelled" && state.message !== undefined)
                return yield* new ToolFailure({ message: state.message })
              if (state.status === "cancelled") return yield* Effect.die(new CancelledError())
              const response = responseOf(block, state.answer)
              const decided = FormDecision.take(FormDecision.key(context.messageID, context.id))
              return {
                output: { type: block.type, response },
                content: toModelContent(block, response),
                metadata: {
                  interactiveBlock: block,
                  interactiveResponse: response,
                  ...(decided ? { answeredBy: decided } : {}),
                },
              }
            }),
        }),
      )
      .pipe(Effect.orDie)
  }),
}
