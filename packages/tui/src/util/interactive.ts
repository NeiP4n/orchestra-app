// Structural views over interactive block payloads (@orchestra/schema/interactive).
// Blocks arrive as tool input, tool metadata and form metadata — all unknown
// at the rendering boundary — so every renderer narrows through here instead
// of trusting the shape. Display only: nothing in this file can grant,
// execute or modify anything.

export interface InteractiveOptionView {
  readonly id: string
  readonly label: string
  readonly description?: string
  readonly pros?: ReadonlyArray<string>
  readonly cons?: ReadonlyArray<string>
  readonly risks?: ReadonlyArray<string>
  readonly consequences?: string
  readonly cost?: string
  readonly recommended?: boolean
  readonly evidence?: ReadonlyArray<string>
}

export interface InteractiveItemView {
  readonly id: string
  readonly name: string
  readonly summary?: string
  readonly attributes?: Readonly<Record<string, string>>
  readonly strengths?: ReadonlyArray<string>
  readonly weaknesses?: ReadonlyArray<string>
  readonly rating?: number
  readonly recommended?: boolean
}

export interface InteractiveTaskView {
  readonly title: string
  readonly status: string
  readonly detail?: string
  readonly agent?: string
  readonly evidence?: string
}

export type InteractiveBlockView =
  | {
      readonly type: "decision"
      readonly title: string
      readonly description?: string
      readonly options: ReadonlyArray<InteractiveOptionView>
      readonly multiple?: boolean
    }
  | {
      readonly type: "comparison"
      readonly title: string
      readonly description?: string
      readonly items: ReadonlyArray<InteractiveItemView>
    }
  | {
      readonly type: "approval"
      readonly title: string
      readonly description?: string
      readonly action: string
      readonly consequences?: ReadonlyArray<string>
      readonly risks?: ReadonlyArray<string>
      readonly destructive?: boolean
    }
  | {
      readonly type: "plan"
      readonly title: string
      readonly description?: string
      readonly phases: ReadonlyArray<{
        readonly title: string
        readonly tasks: ReadonlyArray<InteractiveTaskView>
      }>
    }
  | {
      readonly type: "visualization"
      readonly title: string
      readonly description?: string
      readonly chart: Readonly<Record<string, unknown>>
    }

export interface InteractiveResponseView {
  readonly selected?: ReadonlyArray<string>
  readonly decision?: "approved" | "rejected" | "changes-requested"
  readonly comment?: string
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function strList(value: unknown): ReadonlyArray<string> | undefined {
  if (!Array.isArray(value)) return undefined
  const items = value.filter((item): item is string => typeof item === "string")
  return items.length ? items : undefined
}

function listOf(value: unknown): ReadonlyArray<Record<string, unknown>> {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    const found = record(item)
    return found ? [found] : []
  })
}

export function interactiveBlockOf(value: unknown): InteractiveBlockView | undefined {
  const block = record(value)
  if (!block) return undefined
  const title = str(block.title)
  if (!title) return undefined
  const description = str(block.description)
  if (block.type === "decision") {
    const options = listOf(block.options).flatMap((option) => {
      const id = str(option.id)
      const label = str(option.label)
      if (!id || !label) return []
      return [
        {
          id,
          label,
          description: str(option.description),
          pros: strList(option.pros),
          cons: strList(option.cons),
          risks: strList(option.risks),
          consequences: str(option.consequences),
          cost: str(option.cost),
          recommended: option.recommended === true ? true : undefined,
          evidence: strList(option.evidence),
        } satisfies InteractiveOptionView,
      ]
    })
    if (!options.length) return undefined
    return { type: "decision", title, description, options, multiple: block.multiple === true ? true : undefined }
  }
  if (block.type === "comparison") {
    const items = listOf(block.items).flatMap((item) => {
      const id = str(item.id)
      const name = str(item.name)
      if (!id || !name) return []
      const rawAttributes = record(item.attributes)
      const attributes = rawAttributes
        ? Object.fromEntries(
            Object.entries(rawAttributes).flatMap(([key, val]) => {
              const text = str(val)
              return text !== undefined ? [[key, text] as const] : []
            }),
          )
        : undefined
      return [
        {
          id,
          name,
          summary: str(item.summary),
          attributes: attributes && Object.keys(attributes).length ? attributes : undefined,
          strengths: strList(item.strengths),
          weaknesses: strList(item.weaknesses),
          rating: num(item.rating),
          recommended: item.recommended === true ? true : undefined,
        } satisfies InteractiveItemView,
      ]
    })
    if (!items.length) return undefined
    return { type: "comparison", title, description, items }
  }
  if (block.type === "approval") {
    const action = str(block.action)
    if (!action) return undefined
    return {
      type: "approval",
      title,
      description,
      action,
      consequences: strList(block.consequences),
      risks: strList(block.risks),
      destructive: block.destructive === true ? true : undefined,
    }
  }
  if (block.type === "plan") {
    const phases = listOf(block.phases).map((phase) => ({
      title: str(phase.title) ?? "",
      tasks: listOf(phase.tasks).flatMap((task) => {
        const taskTitle = str(task.title)
        const status = str(task.status)
        if (!taskTitle || !status) return []
        return [
          {
            title: taskTitle,
            status,
            detail: str(task.detail),
            agent: str(task.agent),
            evidence: str(task.evidence),
          } satisfies InteractiveTaskView,
        ]
      }),
    }))
    return { type: "plan", title, description, phases }
  }
  if (block.type === "visualization") {
    const chart = record(block.chart)
    if (!chart || typeof chart.kind !== "string") return undefined
    return { type: "visualization", title, description, chart }
  }
  return undefined
}

export function interactiveResponseOf(value: unknown): InteractiveResponseView | undefined {
  const response = record(value)
  if (!response) return undefined
  const decision = str(response.decision)
  return {
    selected: strList(response.selected),
    decision:
      decision === "approved" || decision === "rejected" || decision === "changes-requested" ? decision : undefined,
    comment: str(response.comment),
  }
}

/** One-glyph status for plan tasks, readable in any terminal font. */
export function statusGlyph(status: string): string {
  switch (status) {
    case "completed":
      return "✓"
    case "running":
      return "▸"
    case "blocked":
      return "⏸"
    case "failed":
      return "✗"
    case "cancelled":
      return "⊘"
    default:
      return "○"
  }
}

export function planProgress(block: Extract<InteractiveBlockView, { type: "plan" }>) {
  const tasks = block.phases.flatMap((phase) => phase.tasks)
  return { done: tasks.filter((task) => task.status === "completed").length, total: tasks.length }
}

/** A fixed-width unicode bar: filled blocks for the value's share of the max. */
export function barFill(value: number, max: number, width: number): string {
  const ratio = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0
  const filled = Math.round(ratio * width)
  return "█".repeat(filled) + "░".repeat(Math.max(0, width - filled))
}
