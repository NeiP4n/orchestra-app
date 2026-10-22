import { tr } from "../util/i18n"
import type { Field, FieldKind, Widget } from "./parse"

// Named keys are words, anything else is the single character that was typed.
export type Key = "up" | "down" | "left" | "right" | "enter" | "tab" | "backtab" | "esc" | "backspace" | (string & {})

export type Outcome =
  | { readonly type: "none" }
  | { readonly type: "answer"; readonly value: string }
  | { readonly type: "copy"; readonly text: string }
  // Hand the keyboard back to the prompt.
  | { readonly type: "release" }
  // The element wants a typed answer in the prompt below.
  | { readonly type: "focus-prompt" }

export type Result = { readonly widget: Widget; readonly outcome: Outcome }

const none: Outcome = { type: "none" }

export function needsAnswer(widget: Widget) {
  switch (widget.kind) {
    case "choice":
    case "multi":
    case "confirm":
    case "buttons":
    case "input":
    case "form":
    case "scale":
    case "diff":
    case "rank":
    case "run":
      return true
    case "table":
    case "tree":
      return widget.select
    default:
      return false
  }
}

// Read-only elements that still respond to keys (switching pages, copying code).
export function browsable(widget: Widget) {
  return widget.kind === "tabs" || widget.kind === "code"
}

export function pending(widget: Widget) {
  return needsAnswer(widget) && widget.answered === undefined
}

// The text sent to the model for an answer to this element.
export function reply(widget: Widget, value: string) {
  return widget.title ? tr("Answer to “{title}”: {value}", { title: widget.title, value }) : tr("Answer: {value}", { value })
}

const step = (cursor: number, length: number, delta: number) => (length === 0 ? 0 : (((cursor + delta) % length) + length) % length)

const answer = (widget: Widget, value: string): Result => ({ widget: { ...widget, answered: value }, outcome: { type: "answer", value } })
const stay = (widget: Widget): Result => ({ widget, outcome: none })
const digit = (key: Key) => (/^[1-9]$/.test(key) ? Number(key) : undefined)

export function press(widget: Widget, key: Key): Result {
  if (key === "esc") return { widget, outcome: { type: "release" } }
  switch (widget.kind) {
    case "choice": {
      if (key === "up" || key === "k") return stay({ ...widget, cursor: step(widget.cursor, widget.items.length, -1) })
      if (key === "down" || key === "j") return stay({ ...widget, cursor: step(widget.cursor, widget.items.length, 1) })
      const quick = digit(key)
      if (quick !== undefined && quick <= widget.items.length) return answer(widget, widget.items[quick - 1].label)
      if (key === "enter") return answer(widget, widget.items[widget.cursor].label)
      return stay(widget)
    }
    case "multi": {
      if (key === "up" || key === "k") return stay({ ...widget, cursor: step(widget.cursor, widget.items.length, -1) })
      if (key === "down" || key === "j") return stay({ ...widget, cursor: step(widget.cursor, widget.items.length, 1) })
      if (key === " ") return stay({ ...widget, on: widget.on.map((on, index) => (index === widget.cursor ? !on : on)) })
      if (key === "a") {
        const all = widget.on.every(Boolean)
        return stay({ ...widget, on: widget.on.map(() => !all) })
      }
      if (key === "enter") {
        const chosen = widget.items.filter((_, index) => widget.on[index]).map((item) => item.label)
        return answer(widget, chosen.length ? chosen.join(", ") : tr("nothing"))
      }
      return stay(widget)
    }
    case "confirm": {
      if (["left", "right", "tab", "backtab"].includes(key)) return stay({ ...widget, cursor: 1 - widget.cursor })
      if (key === "y" || key === "д") return answer(widget, widget.yes)
      if (key === "n" || key === "н") return answer(widget, widget.no)
      if (key === "enter") return answer(widget, widget.cursor === 0 ? widget.yes : widget.no)
      return stay(widget)
    }
    case "buttons": {
      if (key === "left" || key === "up" || key === "backtab") return stay({ ...widget, cursor: step(widget.cursor, widget.labels.length, -1) })
      if (key === "right" || key === "down" || key === "tab") return stay({ ...widget, cursor: step(widget.cursor, widget.labels.length, 1) })
      const quick = digit(key)
      if (quick !== undefined && quick <= widget.labels.length) return answer(widget, widget.labels[quick - 1])
      if (key === "enter") return answer(widget, widget.labels[widget.cursor])
      return stay(widget)
    }
    case "input": {
      if (key === "backspace") return stay({ ...widget, text: widget.text.slice(0, -1) })
      if (key === "enter") return widget.text.trim() ? answer(widget, widget.text.trim()) : stay(widget)
      if ([...key].length === 1) return stay({ ...widget, text: widget.text + key })
      return stay(widget)
    }
    case "form": {
      const last = widget.fields.length
      if (key === "up" || key === "backtab") return stay({ ...widget, cursor: (widget.cursor + last) % (last + 1) })
      if (key === "down" || key === "tab") return stay({ ...widget, cursor: (widget.cursor + 1) % (last + 1) })
      if (key === "enter" && widget.cursor === last) return answer(widget, widget.fields.map((field) => `${field.label}=${fieldValue(field.kind)}`).join("; "))
      if (key === "enter") return stay({ ...widget, cursor: widget.cursor + 1 })
      if (widget.cursor >= last) return stay(widget)
      return stay({ ...widget, fields: widget.fields.map((field, index): Field => (index === widget.cursor ? { ...field, kind: editField(field.kind, key) } : field)) })
    }
    case "scale": {
      if (key === "left" || key === "down" || key === "h") return stay({ ...widget, value: Math.max(widget.min, widget.value - 1) })
      if (key === "right" || key === "up" || key === "l") return stay({ ...widget, value: Math.min(widget.max, widget.value + 1) })
      if (/^[0-9]$/.test(key)) {
        const wanted = Number(key)
        return wanted >= widget.min && wanted <= widget.max ? stay({ ...widget, value: wanted }) : stay(widget)
      }
      if (key === "enter") return answer(widget, widget.stars ? tr("{value} of {max}", { value: widget.value, max: widget.max }) : String(widget.value))
      return stay(widget)
    }
    case "table": {
      if (!widget.select) return stay(widget)
      if (key === "up" || key === "k") return stay({ ...widget, cursor: step(widget.cursor, widget.rows.length, -1) })
      if (key === "down" || key === "j") return stay({ ...widget, cursor: step(widget.cursor, widget.rows.length, 1) })
      if (key === "enter" && widget.rows.length) return answer(widget, widget.rows[widget.cursor].join(" | "))
      return stay(widget)
    }
    case "diff": {
      if (key === "left" || key === "backtab") return stay({ ...widget, cursor: step(widget.cursor, widget.actions.length, -1) })
      if (key === "right" || key === "tab") return stay({ ...widget, cursor: step(widget.cursor, widget.actions.length, 1) })
      const quick = digit(key)
      if (quick !== undefined && quick <= widget.actions.length) return answer(widget, widget.actions[quick - 1])
      if (key === "enter") return answer(widget, widget.actions[widget.cursor])
      return stay(widget)
    }
    case "rank": {
      // Up and down move the item under the cursor, so reordering is just walking it to its place.
      if (key === "up" || key === "k") return stay(moveRank(widget, -1))
      if (key === "down" || key === "j") return stay(moveRank(widget, 1))
      if (key === "enter") return answer(widget, widget.items.join(" > "))
      return stay(widget)
    }
    case "tree": {
      if (!widget.select) return stay(widget)
      if (key === "up" || key === "k") return stay({ ...widget, cursor: step(widget.cursor, widget.nodes.length, -1) })
      if (key === "down" || key === "j") return stay({ ...widget, cursor: step(widget.cursor, widget.nodes.length, 1) })
      if (key === "enter") return answer(widget, treePath(widget.nodes, widget.cursor))
      return stay(widget)
    }
    case "run": {
      if (key === "up" || key === "k") return stay({ ...widget, cursor: step(widget.cursor, widget.items.length, -1) })
      if (key === "down" || key === "j") return stay({ ...widget, cursor: step(widget.cursor, widget.items.length, 1) })
      if (key === "c") return { widget, outcome: { type: "copy", text: widget.items[widget.cursor].command } }
      if (key === "enter") return answer(widget, tr("run `{command}`", { command: widget.items[widget.cursor].command }))
      return stay(widget)
    }
    case "tabs": {
      if (key === "left" || key === "backtab" || key === "h") return stay({ ...widget, current: step(widget.current, widget.pages.length, -1) })
      if (key === "right" || key === "tab" || key === "l") return stay({ ...widget, current: step(widget.current, widget.pages.length, 1) })
      return stay(widget)
    }
    case "code":
      return key === "c" ? { widget, outcome: { type: "copy", text: widget.lines.join("\n") } } : stay(widget)
    default:
      return stay(widget)
  }
}

// A click on a spot of an element. `target` is what the renderer attached to that spot.
export function activate(widget: Widget, target: number): Result {
  switch (widget.kind) {
    case "choice":
      return target < widget.items.length ? answer(widget, widget.items[target].label) : stay(widget)
    case "multi":
      if (target === -1) return press(widget, "enter")
      return target < widget.items.length ? stay({ ...widget, cursor: target, on: widget.on.map((on, index) => (index === target ? !on : on)) }) : stay(widget)
    case "confirm":
      return answer(widget, target === 0 ? widget.yes : widget.no)
    case "buttons":
      return target < widget.labels.length ? answer(widget, widget.labels[target]) : stay(widget)
    case "input":
      return { widget, outcome: { type: "focus-prompt" } }
    case "form": {
      if (target === widget.fields.length) return press({ ...widget, cursor: target }, "enter")
      const field = widget.fields[target]
      if (!field) return stay(widget)
      // Toggles and selects change on the click itself; typed fields just take the cursor.
      const kind = field.kind.type === "bool" || field.kind.type === "select" ? editField(field.kind, "right") : field.kind
      return stay({ ...widget, cursor: target, fields: widget.fields.map((item, index) => (index === target ? { ...item, kind } : item)) })
    }
    case "scale":
      if (target === -1) return press(widget, "enter")
      return stay({ ...widget, value: Math.min(widget.max, Math.max(widget.min, target)) })
    case "table":
      return widget.select && widget.rows[target] ? answer(widget, widget.rows[target].join(" | ")) : stay(widget)
    case "diff":
      return target < widget.actions.length ? answer(widget, widget.actions[target]) : stay(widget)
    case "rank": {
      if (target === -1) return press(widget, "enter")
      return stay(moveRank({ ...widget, cursor: target }, -1))
    }
    case "tree":
      return widget.select && widget.nodes[target] ? answer(widget, treePath(widget.nodes, target)) : stay(widget)
    case "run":
      return widget.items[target] ? answer(widget, tr("run `{command}`", { command: widget.items[target].command })) : stay(widget)
    case "tabs":
      return target < widget.pages.length ? stay({ ...widget, current: target }) : stay(widget)
    case "code":
      return { widget, outcome: { type: "copy", text: widget.lines.join("\n") } }
    default:
      return stay(widget)
  }
}

function moveRank(widget: Extract<Widget, { kind: "rank" }>, delta: number): Widget {
  const to = widget.cursor + delta
  if (to < 0 || to >= widget.items.length) return widget
  const items = [...widget.items]
  ;[items[widget.cursor], items[to]] = [items[to], items[widget.cursor]]
  return { ...widget, items, cursor: to }
}

function fieldValue(kind: FieldKind) {
  if (kind.type === "bool") return kind.value ? tr("yes") : tr("no")
  if (kind.type === "select") return kind.options[kind.at]
  return kind.value
}

function editField(kind: FieldKind, key: Key): FieldKind {
  switch (kind.type) {
    case "text":
      if (key === "backspace") return { ...kind, value: kind.value.slice(0, -1) }
      return [...key].length === 1 ? { ...kind, value: kind.value + key } : kind
    case "number":
      if (key === "backspace") return { ...kind, value: kind.value.slice(0, -1) }
      return /^[0-9.\-]$/.test(key) ? { ...kind, value: kind.value + key } : kind
    case "bool":
      return key === " " || key === "left" || key === "right" ? { ...kind, value: !kind.value } : kind
    case "select":
      if (key === "right" || key === " ") return { ...kind, at: (kind.at + 1) % kind.options.length }
      if (key === "left") return { ...kind, at: (kind.at + kind.options.length - 1) % kind.options.length }
      return kind
  }
}

function treePath(nodes: readonly { readonly depth: number; readonly label: string }[], at: number) {
  const parts = [nodes[at].label]
  let depth = nodes[at].depth
  for (let index = at - 1; index >= 0; index--) {
    if (nodes[index].depth < depth) {
      parts.push(nodes[index].label)
      depth = nodes[index].depth
    }
  }
  return parts.reverse().join("/")
}
