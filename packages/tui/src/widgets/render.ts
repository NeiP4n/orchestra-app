import { tr } from "../util/i18n"
import type { Widget } from "./parse"

export type Tone = "normal" | "accent" | "accentBold" | "dim" | "warn" | "warnBold"

// A piece of text; when `target` is set, a click on it activates that spot of the element.
export type Span = { readonly text: string; readonly tone: Tone; readonly target?: number }
export type Line = readonly Span[]

// active: the element has the keyboard. pending: it waits for an answer elsewhere. idle: nothing to do.
export type Focus = "active" | "pending" | "idle"

const span = (text: string, tone: Tone = "normal", target?: number): Span => (target === undefined ? { text, tone } : { text, tone, target })

function cells(text: string) {
  let total = 0
  for (const char of text) total += wide(char.codePointAt(0) ?? 0) ? 2 : 1
  return total
}

// Wide East Asian and emoji ranges take two columns; everything else one.
function wide(code: number) {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0x1f300 && code <= 0x1faff)
  )
}

export function clip(text: string, width: number) {
  if (cells(text) <= width) return text
  let used = 0
  let out = ""
  for (const char of text) {
    const w = wide(char.codePointAt(0) ?? 0) ? 2 : 1
    if (used + w > Math.max(0, width - 1)) return out + "…"
    out += char
    used += w
  }
  return out
}

// Breaks text into lines of at most `width` columns at spaces; a word longer than a line is split by
// columns. Long prose reads better wrapped than clipped with an ellipsis.
export function wrap(text: string, width: number) {
  const size = Math.max(1, width)
  if (cells(text) <= size) return [text]
  const lines: string[] = []
  let line = ""
  for (const word of text.split(" ")) {
    if (cells(word) > size) {
      if (line) lines.push(line)
      const parts = split(word, size)
      line = parts.pop() ?? ""
      lines.push(...parts)
      continue
    }
    if (!line) line = word
    else if (cells(line) + 1 + cells(word) <= size) line += ` ${word}`
    else {
      lines.push(line)
      line = word
    }
  }
  lines.push(line)
  return lines
}

function split(word: string, width: number) {
  const parts: string[] = []
  let part = ""
  let used = 0
  for (const char of word) {
    const w = wide(char.codePointAt(0) ?? 0) ? 2 : 1
    if (used + w > width && part) {
      parts.push(part)
      part = ""
      used = 0
    }
    part += char
    used += w
  }
  parts.push(part)
  return parts
}

// Shares `available` columns between table columns: short columns keep their natural width and the
// long ones divide what is left, so a narrow label never wastes room a paragraph could use.
function fit(natural: readonly number[], available: number) {
  if (natural.reduce((sum, w) => sum + w, 0) <= available) return [...natural]
  const widths = [...natural]
  let remaining = Math.max(available, natural.length * 3)
  natural
    .map((_, n) => n)
    .sort((a, b) => natural[a] - natural[b])
    .forEach((n, done) => {
      widths[n] = Math.min(natural[n], Math.max(3, Math.floor(remaining / (natural.length - done))))
      remaining -= widths[n]
    })
  return widths
}

function pad(text: string, width: number) {
  return text + " ".repeat(Math.max(0, width - cells(text)))
}

function bar(fraction: number, width: number): Span[] {
  const filled = Math.round(fraction * width)
  return [span("━".repeat(filled), "accent"), span("╌".repeat(width - filled), "dim")]
}

function sparkline(values: readonly number[]) {
  const levels = "▁▂▃▄▅▆▇█"
  const min = Math.min(...values)
  const max = Math.max(...values)
  return values.map((value) => levels[max > min ? Math.round(((value - min) / (max - min)) * 7) : 3]).join("")
}

const kindName: Record<Widget["kind"], string> = {
  choice: tr("choice"),
  multi: tr("multiple"),
  confirm: tr("confirmation"),
  buttons: tr("buttons"),
  input: tr("input"),
  form: tr("form"),
  scale: tr("scale"),
  table: tr("table"),
  progress: tr("progress"),
  steps: tr("steps"),
  diff: tr("changes"),
  code: tr("code"),
  kv: tr("summary"),
  callout: tr("note"),
  tabs: tr("tabs"),
  rank: tr("order"),
  spark: tr("chart"),
  timeline: tr("timeline"),
  tree: tr("tree"),
  run: tr("commands"),
}

export function render(widget: Widget, width: number, focus: Focus): Line[] {
  const columns = Math.max(12, width)
  if (widget.answered !== undefined) {
    const title = widget.title ? `${widget.title} → ` : ""
    return [[span("✓ ", "accent"), span(clip(`${title}${widget.answered}`, columns - 4), "dim")]]
  }
  const rail: Tone = focus === "active" ? "accentBold" : focus === "pending" ? "warnBold" : "dim"
  const inner = columns - 4
  const { body, footer } = bodyOf(widget, inner, focus === "active")
  const lines: Line[] = [[span("╭ ", rail), span(clip(widget.title || kindName[widget.kind], inner), focus === "active" ? "accentBold" : "normal")]]
  for (const line of body) lines.push([span("│ ", rail), ...line])
  const shown = focus === "pending" ? tr("waiting for you · click an item") : footer
  lines.push([span("╰ ", rail), span(clip(shown, inner), "dim")])
  return lines
}

function bodyOf(widget: Widget, width: number, active: boolean): { body: Line[]; footer: string } {
  const mark = (selected: boolean): Span => (selected && active ? span("▸ ", "accentBold") : selected ? span("› ", "accent") : span("  "))
  const button = (label: string, selected: boolean, target: number) =>
    span(label, selected && active ? "accentBold" : selected ? "accent" : "dim", target)
  switch (widget.kind) {
    case "choice":
      return {
        body: widget.items.flatMap((item, n) => {
          const number = `${n + 1} `
          const indent = 2 + cells(number)
          const room = Math.max(4, width - indent)
          const tone = n === widget.cursor ? "accentBold" : "normal"
          const labels = wrap(item.label, room)
          const hint = item.hint ?? ""
          // A short hint stays beside its label. A long one goes under it, wrapped, because the person
          // chooses by reading it and a clipped description cannot be read anywhere else.
          const beside = labels.length === 1 && hint !== "" && cells(item.label) + 2 + cells(hint) <= room
          const lines = labels.map((text, line): Line => [
            ...(line === 0 ? [mark(n === widget.cursor), span(number, "dim")] : [span(" ".repeat(indent))]),
            span(text, tone, n),
            ...(line === 0 && beside ? [span(`  ${hint}`, "dim", n)] : []),
          ])
          if (hint !== "" && !beside) lines.push(...wrap(hint, room).map((text): Line => [span(" ".repeat(indent)), span(text, "dim", n)]))
          return lines
        }),
        footer: tr("↑↓ choose · 1-9 at once · Enter"),
      }
    case "multi":
      return {
        body: [
          ...widget.items.flatMap((item, n) =>
            wrap(item.label, Math.max(4, width - 6)).map((text, line): Line => [
              ...(line === 0
                ? [mark(n === widget.cursor), span(widget.on[n] ? "[x] " : "[ ] ", widget.on[n] ? "accent" : "dim", n)]
                : [span(" ".repeat(6))]),
              span(text, "normal", n),
            ]),
          ),
          [span(tr("[ Done ]"), "accent", -1)],
        ],
        footer: tr("↑↓ · Space marks · a all · Enter"),
      }
    case "confirm":
      return {
        body: [
          ...widget.text.flatMap((line) => wrap(line, width).map((part): Line => [span(part)])),
          [button(`[ ${widget.yes} ]`, widget.cursor === 0, 0), span("  "), button(`[ ${widget.no} ]`, widget.cursor === 1, 1)],
        ],
        footer: "←→ · y/n · Enter",
      }
    case "buttons":
      return {
        body: [widget.labels.flatMap((label, n) => [button(`[${n + 1} ${label}]`, n === widget.cursor, n), span(" ")])],
        footer: "←→ · 1-9 · Enter",
      }
    case "input":
      return {
        body: [
          [
            span("› ", "accent", 0),
            widget.text ? span(clip(widget.text, width - 3)) : span(widget.placeholder || tr("click and answer in the chat"), "dim", 0),
            span(active ? "▏" : "", "accent"),
          ],
        ],
        footer: tr("type · Enter sends"),
      }
    case "form": {
      const rows: Line[] = widget.fields.map((field, n) => {
        const k = field.kind
        const value =
          k.type === "bool" ? (k.value ? tr("[x] yes") : tr("[ ] no")) : k.type === "select" ? `‹ ${k.options[k.at]} ›` : k.value || "…"
        return [
          mark(n === widget.cursor),
          span(`${field.label}: `, "dim", n),
          span(clip(value, width - cells(field.label) - 6), n === widget.cursor ? "accentBold" : "normal", n),
        ]
      })
      rows.push([mark(widget.cursor === widget.fields.length), button(tr("[ Send ]"), widget.cursor === widget.fields.length, widget.fields.length)])
      return { body: rows, footer: tr("↑↓/Tab fields · ←→ choose · Enter") }
    }
    case "scale": {
      if (widget.stars) {
        const stars: Span[] = []
        for (let n = widget.min; n <= widget.max; n++) stars.push(span(n <= widget.value ? "★" : "☆", "accent", n))
        return { body: [[...stars, span(`  ${widget.value}/${widget.max}`, "dim"), span(tr("  [ Done ]"), "accent", -1)]], footer: tr("←→ change · digit · Enter") }
      }
      const track: Span[] = []
      for (let n = widget.min; n <= widget.max; n++) track.push(span(n === widget.value ? "●" : "─", "accent", n))
      return {
        body: [[span(widget.low ? `${widget.low} ` : "", "dim"), ...track, span(` ${widget.high}  ${widget.value}`, "dim"), span(tr("  [ Done ]"), "accent", -1)]],
        footer: tr("←→ change · digit · Enter"),
      }
    }
    case "table": {
      const count = Math.max(widget.cols.length, ...widget.rows.map((row) => row.length), 1)
      const widths = Array.from({ length: count }, (_, n) => Math.max(cells(widget.cols[n] ?? ""), ...widget.rows.map((row) => cells(row[n] ?? ""))))
      const fitted = fit(widths, width - 2 - 3 * (count - 1))
      // A row is as tall as its tallest wrapped cell; only its first line carries the marker.
      const row = (cellsOf: readonly string[], tone: Tone, lead: Span, target?: number): Line[] => {
        const parts = fitted.map((w, n) => wrap(cellsOf[n] ?? "", w))
        return Array.from({ length: Math.max(...parts.map((part) => part.length)) }, (_, line): Line => [
          line === 0 ? lead : span("  "),
          ...fitted.flatMap((w, n): Span[] => [span(pad(parts[n][line] ?? "", w), tone, target), ...(n + 1 < count ? [span(" │ ", "dim")] : [])]),
        ])
      }
      const body: Line[] = []
      if (widget.cols.length) body.push(...row(widget.cols, "accentBold", span("  ")))
      widget.rows.forEach((cellsOf, n) =>
        body.push(...row(cellsOf, widget.select && n === widget.cursor ? "accentBold" : "normal", widget.select ? mark(n === widget.cursor) : span("  "), n)),
      )
      return { body, footer: widget.select ? tr("↑↓ · Enter picks a row") : "" }
    }
    case "progress": {
      const name = Math.max(...widget.items.map((item) => cells(item.label)))
      return { body: widget.items.map((item) => [span(`${pad(item.label, name)} `), ...bar(item.fraction, 16), span(` ${item.shown}`, "dim")]), footer: "" }
    }
    case "steps":
      return {
        body: widget.items.flatMap((item): Line[] => {
          const [markText, tone]: [string, Tone] =
            item.state === "x" ? ["✓ ", "dim"] : item.state === "~" ? ["… ", "warnBold"] : item.state === "!" ? ["✗ ", "warn"] : ["○ ", "normal"]
          return wrap(item.label, width - 2).map((part, i): Line => [
            i === 0 ? span(markText, item.state === "x" ? "accent" : tone) : span("  "),
            span(part, tone),
          ])
        }),
        footer: "",
      }
    case "diff": {
      const shown = 14
      const body: Line[] = widget.lines.slice(0, shown).map((line) => {
        const tone: Tone = line.startsWith("+") && !line.startsWith("+++") ? "accent" : line.startsWith("-") && !line.startsWith("---") ? "warn" : "dim"
        return [span(clip(line, width), tone)]
      })
      if (widget.lines.length > shown) body.push([span(tr("… {count} more lines", { count: widget.lines.length - shown }), "dim")])
      body.push(widget.actions.flatMap((action, n) => [button(`[${n + 1} ${action}]`, n === widget.cursor, n), span(" ")]))
      return { body, footer: "←→ · 1-9 · Enter" }
    }
    case "code":
      return {
        body: [
          ...(widget.lang ? [[span(widget.lang, "dim")] as Line] : []),
          ...widget.lines.map((line, n): Line => [span(`${String(n + 1).padStart(2)} `, "dim"), span(clip(line, width - 3))]),
          [span(tr("[ copy ]"), "accent", 0)],
        ],
        footer: tr("c — copy"),
      }
    case "kv": {
      const key = Math.min(Math.max(...widget.pairs.map(([name]) => cells(name))), Math.floor(width / 2))
      return {
        body: widget.pairs.flatMap(([name, value]) => {
          const names = wrap(name, key)
          const values = wrap(value, Math.max(4, width - key - 2))
          return Array.from({ length: Math.max(names.length, values.length) }, (_, line): Line => [
            span(`${pad(names[line] ?? "", key)}  `, "dim"),
            span(values[line] ?? ""),
          ])
        }),
        footer: "",
      }
    }
    case "callout": {
      const [markText, tone]: [string, Tone] = ["warn", "warning", "error"].includes(widget.tone) ? ["! ", "warn"] : ["ok", "done"].includes(widget.tone) ? ["✓ ", "accent"] : ["i ", "accent"]
      return {
        body: widget.lines.flatMap((line, n) =>
          wrap(line, width - 2).map((part, i): Line => [span(n === 0 && i === 0 ? markText : "  ", tone), span(part)]),
        ),
        footer: "",
      }
    }
    case "tabs":
      return {
        body: [
          widget.pages.flatMap((page, n) => [span(n === widget.current ? `[${page.name}]` : ` ${page.name} `, n === widget.current ? "accentBold" : "dim", n), span(" ")]),
          ...widget.pages[widget.current].lines.flatMap((line) => wrap(line, width).map((part): Line => [span(part)])),
        ],
        footer: tr("←→ pages"),
      }
    case "rank":
      return {
        body: [
          ...widget.items.map((item, n) => [mark(n === widget.cursor), span(`${n + 1}. `, "dim"), span(clip(item, width - 7), n === widget.cursor ? "accentBold" : "normal", n), span(n === widget.cursor ? tr("  ▲ up") : "", "dim", n)]),
          [span(tr("[ Done ]"), "accent", -1)],
        ],
        footer: tr("↑↓ move item · click — up · Enter"),
      }
    case "spark": {
      const label = widget.label ? `  ${widget.label}` : ""
      return { body: [[span(sparkline(widget.values), "accent"), span(`  ${Math.min(...widget.values)}…${Math.max(...widget.values)}${label}`, "dim")]], footer: "" }
    }
    case "timeline":
      return {
        body: widget.events.flatMap(([when, what], n) => {
          const last = n + 1 === widget.events.length
          return wrap(what, Math.max(4, width - cells(when) - 5)).map((part, i): Line =>
            i === 0
              ? [span(last ? "└ " : "├ ", "dim"), span(`${when}  `, "accent"), span(part)]
              : [span(last ? "  " : "│ ", "dim"), span(" ".repeat(cells(when) + 2)), span(part)],
          )
        }),
        footer: "",
      }
    case "tree":
      return {
        body: widget.nodes.map((node, n) => [
          widget.select ? mark(n === widget.cursor) : span("  "),
          span(node.depth === 0 ? "" : `${"  ".repeat(node.depth - 1)}└ `, "dim"),
          span(clip(node.label, Math.max(4, width - node.depth * 2 - 3)), widget.select && n === widget.cursor ? "accentBold" : "normal", n),
        ]),
        footer: widget.select ? tr("↑↓ · Enter picks") : "",
      }
    case "run":
      return {
        body: widget.items.map((item, n) => [
          mark(n === widget.cursor),
          span(clip(item.label, width - 4), n === widget.cursor ? "accentBold" : "normal", n),
          ...(item.label === item.command ? [] : [span(`  $ ${clip(item.command, Math.max(4, width - cells(item.label) - 8))}`, "dim")]),
        ]),
        footer: tr("↑↓ · Enter runs · c copies"),
      }
  }
}
