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
  choice: "выбор",
  multi: "несколько",
  confirm: "подтверждение",
  buttons: "кнопки",
  input: "ввод",
  form: "форма",
  scale: "шкала",
  table: "таблица",
  progress: "прогресс",
  steps: "шаги",
  diff: "изменения",
  code: "код",
  kv: "сводка",
  callout: "заметка",
  tabs: "вкладки",
  rank: "порядок",
  spark: "график",
  timeline: "хронология",
  tree: "дерево",
  run: "команды",
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
  const shown = focus === "pending" ? "ждёт вас · нажмите на элемент" : footer
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
        body: widget.items.map((item, n) => [
          mark(n === widget.cursor),
          span(`${n + 1} `, "dim"),
          span(clip(item.label, width - 6), n === widget.cursor ? "accentBold" : "normal", n),
          ...(item.hint ? [span(`  ${clip(item.hint, Math.max(4, width - cells(item.label) - 8))}`, "dim")] : []),
        ]),
        footer: "↑↓ выбор · 1-9 сразу · Enter",
      }
    case "multi":
      return {
        body: [
          ...widget.items.map((item, n) => [
            mark(n === widget.cursor),
            span(widget.on[n] ? "[x] " : "[ ] ", widget.on[n] ? "accent" : "dim", n),
            span(clip(item.label, width - 8), "normal", n),
          ]),
          [span("[ Готово ]", "accent", -1)],
        ],
        footer: "↑↓ · Space отметить · a все · Enter",
      }
    case "confirm":
      return {
        body: [
          ...widget.text.map((line) => [span(clip(line, width))]),
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
            widget.text ? span(clip(widget.text, width - 3)) : span(widget.placeholder || "нажмите и ответьте в чате", "dim", 0),
            span(active ? "▏" : "", "accent"),
          ],
        ],
        footer: "печатайте · Enter отправить",
      }
    case "form": {
      const rows: Line[] = widget.fields.map((field, n) => {
        const k = field.kind
        const value =
          k.type === "bool" ? (k.value ? "[x] да" : "[ ] нет") : k.type === "select" ? `‹ ${k.options[k.at]} ›` : k.value || "…"
        return [
          mark(n === widget.cursor),
          span(`${field.label}: `, "dim", n),
          span(clip(value, width - cells(field.label) - 6), n === widget.cursor ? "accentBold" : "normal", n),
        ]
      })
      rows.push([mark(widget.cursor === widget.fields.length), button("[ Отправить ]", widget.cursor === widget.fields.length, widget.fields.length)])
      return { body: rows, footer: "↑↓/Tab поля · ←→ выбор · Enter" }
    }
    case "scale": {
      if (widget.stars) {
        const stars: Span[] = []
        for (let n = widget.min; n <= widget.max; n++) stars.push(span(n <= widget.value ? "★" : "☆", "accent", n))
        return { body: [[...stars, span(`  ${widget.value}/${widget.max}`, "dim"), span("  [ Готово ]", "accent", -1)]], footer: "←→ изменить · цифра · Enter" }
      }
      const track: Span[] = []
      for (let n = widget.min; n <= widget.max; n++) track.push(span(n === widget.value ? "●" : "─", "accent", n))
      return {
        body: [[span(widget.low ? `${widget.low} ` : "", "dim"), ...track, span(` ${widget.high}  ${widget.value}`, "dim"), span("  [ Готово ]", "accent", -1)]],
        footer: "←→ изменить · цифра · Enter",
      }
    }
    case "table": {
      const count = Math.max(widget.cols.length, ...widget.rows.map((row) => row.length), 1)
      const widths = Array.from({ length: count }, (_, n) => Math.max(cells(widget.cols[n] ?? ""), ...widget.rows.map((row) => cells(row[n] ?? ""))))
      const total = widths.reduce((sum, w) => sum + w, 0) + 3 * (count - 1)
      if (total > width - 2) {
        const cut = Math.ceil((total - (width - 2)) / count)
        widths.forEach((w, n) => (widths[n] = Math.max(3, w - cut)))
      }
      const row = (cellsOf: readonly string[], tone: Tone, target?: number): Span[] =>
        widths.flatMap((w, n): Span[] => [span(pad(clip(cellsOf[n] ?? "", w + 1), w), tone, target), ...(n + 1 < count ? [span(" │ ", "dim")] : [])])
      const body: Line[] = []
      if (widget.cols.length) body.push([span("  "), ...row(widget.cols, "accentBold")])
      widget.rows.forEach((cellsOf, n) => body.push([widget.select ? mark(n === widget.cursor) : span("  "), ...row(cellsOf, widget.select && n === widget.cursor ? "accentBold" : "normal", n)]))
      return { body, footer: widget.select ? "↑↓ · Enter выбрать строку" : "" }
    }
    case "progress": {
      const name = Math.max(...widget.items.map((item) => cells(item.label)))
      return { body: widget.items.map((item) => [span(`${pad(item.label, name)} `), ...bar(item.fraction, 16), span(` ${item.shown}`, "dim")]), footer: "" }
    }
    case "steps":
      return {
        body: widget.items.map((item): Line => {
          const [markText, tone]: [string, Tone] =
            item.state === "x" ? ["✓ ", "dim"] : item.state === "~" ? ["… ", "warnBold"] : item.state === "!" ? ["✗ ", "warn"] : ["○ ", "normal"]
          return [span(markText, item.state === "x" ? "accent" : tone), span(clip(item.label, width - 2), tone)]
        }),
        footer: "",
      }
    case "diff": {
      const shown = 14
      const body: Line[] = widget.lines.slice(0, shown).map((line) => {
        const tone: Tone = line.startsWith("+") && !line.startsWith("+++") ? "accent" : line.startsWith("-") && !line.startsWith("---") ? "warn" : "dim"
        return [span(clip(line, width), tone)]
      })
      if (widget.lines.length > shown) body.push([span(`… ещё ${widget.lines.length - shown} строк`, "dim")])
      body.push(widget.actions.flatMap((action, n) => [button(`[${n + 1} ${action}]`, n === widget.cursor, n), span(" ")]))
      return { body, footer: "←→ · 1-9 · Enter" }
    }
    case "code":
      return {
        body: [
          ...(widget.lang ? [[span(widget.lang, "dim")] as Line] : []),
          ...widget.lines.map((line, n): Line => [span(`${String(n + 1).padStart(2)} `, "dim"), span(clip(line, width - 3))]),
          [span("[ копировать ]", "accent", 0)],
        ],
        footer: "c — копировать",
      }
    case "kv": {
      const key = Math.max(...widget.pairs.map(([name]) => cells(name)))
      return { body: widget.pairs.map(([name, value]) => [span(`${pad(name, key)}  `, "dim"), span(clip(value, width - key - 2))]), footer: "" }
    }
    case "callout": {
      const [markText, tone]: [string, Tone] = ["warn", "warning", "error"].includes(widget.tone) ? ["! ", "warn"] : ["ok", "done"].includes(widget.tone) ? ["✓ ", "accent"] : ["i ", "accent"]
      return { body: widget.lines.map((line, n) => [span(n === 0 ? markText : "  ", tone), span(clip(line, width - 2))]), footer: "" }
    }
    case "tabs":
      return {
        body: [
          widget.pages.flatMap((page, n) => [span(n === widget.current ? `[${page.name}]` : ` ${page.name} `, n === widget.current ? "accentBold" : "dim", n), span(" ")]),
          ...widget.pages[widget.current].lines.map((line) => [span(clip(line, width))]),
        ],
        footer: "←→ страницы",
      }
    case "rank":
      return {
        body: [
          ...widget.items.map((item, n) => [mark(n === widget.cursor), span(`${n + 1}. `, "dim"), span(clip(item, width - 7), n === widget.cursor ? "accentBold" : "normal", n), span(n === widget.cursor ? "  ▲ выше" : "", "dim", n)]),
          [span("[ Готово ]", "accent", -1)],
        ],
        footer: "↑↓ двигать элемент · клик — выше · Enter",
      }
    case "spark": {
      const label = widget.label ? `  ${widget.label}` : ""
      return { body: [[span(sparkline(widget.values), "accent"), span(`  ${Math.min(...widget.values)}…${Math.max(...widget.values)}${label}`, "dim")]], footer: "" }
    }
    case "timeline":
      return {
        body: widget.events.map(([when, what], n) => [span(n + 1 === widget.events.length ? "└ " : "├ ", "dim"), span(`${when}  `, "accent"), span(clip(what, width - cells(when) - 5))]),
        footer: "",
      }
    case "tree":
      return {
        body: widget.nodes.map((node, n) => [
          widget.select ? mark(n === widget.cursor) : span("  "),
          span(node.depth === 0 ? "" : `${"  ".repeat(node.depth - 1)}└ `, "dim"),
          span(clip(node.label, Math.max(4, width - node.depth * 2 - 3)), widget.select && n === widget.cursor ? "accentBold" : "normal", n),
        ]),
        footer: widget.select ? "↑↓ · Enter выбрать" : "",
      }
    case "run":
      return {
        body: widget.items.map((item, n) => [
          mark(n === widget.cursor),
          span(clip(item.label, width - 4), n === widget.cursor ? "accentBold" : "normal", n),
          ...(item.label === item.command ? [] : [span(`  $ ${clip(item.command, Math.max(4, width - cells(item.label) - 8))}`, "dim")]),
        ]),
        footer: "↑↓ · Enter выполнить · c копировать",
      }
  }
}
