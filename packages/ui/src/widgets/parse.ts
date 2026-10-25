import { tr } from "./i18n"
import type { Field, Item, Kind, Segment, Widget } from "./types"
export { KINDS } from "./types"
export type { Field, Item, Kind, Segment, Widget } from "./types"

export function parse(text: string): Segment[] {
  const lines = text.split(/\r?\n/)
  const segments: Segment[] = []
  let buffer: string[] = []
  let index = 0
  const flush = () => {
    const joined = buffer.join("\n")
    buffer = []
    if (joined.trim()) segments.push({ type: "text", text: joined.trimEnd() })
  }
  while (index < lines.length) {
    const head = blockHead(lines[index])
    if (head !== undefined) {
      let end = index + 1
      while (end < lines.length && lines[end].trim() !== "@end") end++
      const widget = build(head, lines.slice(index + 1, end))
      if (widget) {
        // Models like to wrap blocks in code fences; the fence is not content.
        if (buffer.at(-1)?.trim().startsWith("```")) buffer.pop()
        flush()
        segments.push({ type: "widget", widget })
        index = end + 1
        if (lines[index]?.trim().startsWith("```")) index++
        continue
      }
    }
    buffer.push(lines[index])
    index++
  }
  flush()
  return segments
}

function blockHead(line: string) {
  const trimmed = line.trim()
  if (trimmed === "@ui") return ""
  if (trimmed.startsWith("@ui ")) return trimmed.slice(4).trim()
  return undefined
}

function itemsOf(body: readonly string[]): Item[] {
  return body.flatMap((line) => {
    const rest = line.trim().startsWith("- ") ? line.trim().slice(2) : undefined
    if (rest === undefined) return []
    const bar = rest.indexOf("|")
    const label = (bar < 0 ? rest : rest.slice(0, bar)).trim()
    const hint = bar < 0 ? "" : rest.slice(bar + 1).trim()
    if (!label) return []
    return [hint ? { label, hint } : { label }]
  })
}

function setting(body: readonly string[], key: string) {
  for (const line of body) {
    const trimmed = line.trim()
    if (trimmed.startsWith(`${key}:`)) return trimmed.slice(key.length + 1).trim()
  }
  return undefined
}

function build(head: string, body: readonly string[]): Widget | undefined {
  const space = head.indexOf(" ")
  const kind = (space < 0 ? head : head.slice(0, space)).toLowerCase()
  const title = space < 0 ? "" : head.slice(space + 1).trim()
  const items = itemsOf(body)
  const made = (value: Kind): Widget => ({ ...value, title })
  switch (kind) {
    case "choice":
      return items.length ? made({ kind, items, cursor: 0 }) : undefined
    case "multi": {
      if (!items.length) return undefined
      const marked = body.map((line) => line.trim()).filter((line) => line.startsWith("- "))
      return made({
        kind,
        items: items.map((item) => ({ ...item, label: item.label.replace(/^\[[ xX]\]\s*/, "") })),
        on: marked.map((line) => /^- \[[xX]\]/.test(line)),
        cursor: 0,
      })
    }
    case "confirm": {
      const text = body.map((line) => line.trim()).filter((line) => line && !line.startsWith("yes:") && !line.startsWith("no:"))
      return made({ kind, text, yes: setting(body, "yes") || tr("Yes"), no: setting(body, "no") || tr("No"), cursor: 0 })
    }
    case "buttons":
      return items.length ? made({ kind, labels: items.map((item) => item.label), cursor: 0 }) : undefined
    case "input":
      return made({ kind, placeholder: setting(body, "placeholder") ?? "", text: setting(body, "default") ?? "" })
    case "form": {
      const fields = body.flatMap((line) => {
        const rest = line.trim().startsWith("- ") ? line.trim().slice(2) : undefined
        const parsed = rest === undefined ? undefined : fieldOf(rest)
        return parsed ? [parsed] : []
      })
      return fields.length ? made({ kind, fields, cursor: 0 }) : undefined
    }
    case "scale": {
      const range = setting(body, "range")?.match(/^(-?\d+)\s*-\s*(-?\d+)$/)
      const [min, max] = range && Number(range[1]) < Number(range[2]) ? [Number(range[1]), Number(range[2])] : [1, 10]
      const wanted = Number(setting(body, "default"))
      const value = Math.min(max, Math.max(min, Number.isFinite(wanted) && setting(body, "default") ? wanted : Math.floor((min + max) / 2)))
      const labels = setting(body, "labels")?.split("..") ?? []
      return made({ kind, min, max, value, low: labels[0]?.trim() ?? "", high: labels[1]?.trim() ?? "", stars: setting(body, "style") === "stars" })
    }
    case "table": {
      const cols = (setting(body, "cols") ?? "").split("|").map((cell) => cell.trim()).filter(Boolean)
      const rows = body
        .map((line) => line.trim())
        .filter((line) => line.startsWith("- "))
        .map((line) => line.slice(2).split("|").map((cell) => cell.trim()))
      if (!cols.length && !rows.length) return undefined
      return made({ kind, cols, rows, select: setting(body, "select") === "true", cursor: 0 })
    }
    case "progress":
      return items.length ? made({ kind, items: items.map((item) => progressOf(item.label)) }) : undefined
    case "steps": {
      const entries = body
        .map((line) => line.trim())
        .filter((line) => line.startsWith("- "))
        .map((line) => {
          const rest = line.slice(2)
          const mark = rest.match(/^\[([ xX~!])\]\s*/)
          return { state: mark ? mark[1].toLowerCase() : " ", label: mark ? rest.slice(mark[0].length) : rest }
        })
      return entries.length ? made({ kind, items: entries }) : undefined
    }
    case "diff": {
      const actions = (setting(body, "actions") ?? "").split("|").map((a) => a.trim()).filter(Boolean)
      return made({
        kind,
        lines: body.filter((line) => !line.trim().startsWith("actions:")).map((line) => line.trimEnd()),
        actions: actions.length ? actions : [tr("Apply"), tr("Reject")],
        cursor: 0,
      })
    }
    case "code":
      return made({ kind, lang: title, lines: body.map((line) => line.trimEnd()) })
    case "kv": {
      const pairs = items.flatMap((item): [string, string][] => {
        const colon = item.label.indexOf(":")
        return colon < 0 ? [] : [[item.label.slice(0, colon).trim(), item.label.slice(colon + 1).trim()]]
      })
      return pairs.length ? made({ kind, pairs }) : undefined
    }
    case "callout":
      return made({ kind, tone: title, lines: body.map((line) => line.trimEnd()) })
    case "tabs": {
      const pages: { name: string; lines: string[] }[] = []
      for (const line of body) {
        if (line.trim().startsWith("# ")) pages.push({ name: line.trim().slice(2).trim(), lines: [] })
        else pages.at(-1)?.lines.push(line.trimEnd())
      }
      return pages.length ? made({ kind, pages, current: 0 }) : undefined
    }
    case "rank":
      return items.length ? made({ kind, items: items.map((item) => item.label), cursor: 0 }) : undefined
    case "spark": {
      const values = (setting(body, "values") ?? "").split(/\s+/).filter(Boolean).map(Number).filter(Number.isFinite)
      return values.length ? made({ kind, label: title, values }) : undefined
    }
    case "timeline":
      return items.length ? made({ kind, events: items.map((item): [string, string] => [item.label, item.hint ?? ""]) }) : undefined
    case "tree": {
      const nodes = body
        .filter((line) => line.trim().startsWith("- "))
        .map((line) => ({ depth: Math.floor((line.length - line.trimStart().length) / 2), label: line.trim().slice(2).trim() }))
      return nodes.length ? made({ kind, nodes, select: setting(body, "select") === "true", cursor: 0 }) : undefined
    }
    case "run":
      return items.length ? made({ kind, items: items.map((item) => ({ label: item.label, command: item.hint ?? item.label })), cursor: 0 }) : undefined
    default:
      return undefined
  }
}

function fieldOf(rest: string): Field | undefined {
  const colon = rest.indexOf(":")
  if (colon < 0) return undefined
  const label = rest.slice(0, colon).trim()
  const spec = rest.slice(colon + 1).trim()
  const space = spec.indexOf(" ")
  const type = space < 0 ? spec : spec.slice(0, space)
  const tail = space < 0 ? "" : spec.slice(space + 1).trim()
  if (type === "text") return { label, kind: { type, value: tail } }
  if (type === "number") return { label, kind: { type, value: tail } }
  if (type === "bool") return { label, kind: { type, value: ["yes", "да", "true"].includes(tail) } }
  if (type === "select") {
    const options = tail.split(",").map((option) => option.trim()).filter(Boolean)
    return options.length ? { label, kind: { type, options, at: 0 } } : undefined
  }
  return undefined
}

function progressOf(label: string) {
  const colon = label.lastIndexOf(":")
  const name = colon < 0 ? label : label.slice(0, colon)
  const value = colon < 0 ? "" : label.slice(colon + 1).trim()
  const percent = value.match(/^(\d+(?:\.\d+)?)\s*%$/)
  const ratio = value.match(/^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/)
  const fraction = percent ? Number(percent[1]) / 100 : ratio && Number(ratio[2]) > 0 ? Number(ratio[1]) / Number(ratio[2]) : 0
  return { label: name.trim(), fraction: Math.min(1, Math.max(0, fraction)), shown: value }
}

export const GUIDE = [
  "You can answer with interactive elements. Write a block: a line `@ui <kind> <title>`, the body, then `@end`.",
  "The person's action comes back as a normal message. Use an element that needs an answer only for a decision that is genuinely the person's; decide everything else yourself and keep working. Display elements (progress, steps, diff, code, kv, callout, table, timeline, tree) need no answer; ordinary text may surround them.",
  "Kinds:",
  "choice (one of: `- label | hint`), multi (`- [x] label`, many), confirm (text lines, optional `yes:` `no:`), buttons (`- label`),",
  "input (`placeholder:` `default:`), form (`- Name: text default` | number | bool yes | select a, b, c),",
  "scale (`range: 1-10` `default:` `labels: low..high` `style: stars`),",
  "table (`cols: a | b` then `- x | y` rows; `select: true` to pick a row), progress (`- Build: 60%` or `- Tests: 3/10`),",
  "steps (`- [x] done`, `- [~] doing`, `- [ ] todo`, `- [!] failed`), diff (unified diff lines; optional `actions: Apply | Reject | Explain`),",
  "code (title = language, body = code; the person can copy), kv (`- key: value`), callout (title = info|warn|ok, body text),",
  "tabs (`# Page` headings with lines under each), rank (`- item`, the person reorders), spark (`values: 1 3 2 5`),",
  "timeline (`- 10:00 | event`), tree (indented `- node`; `select: true` to pick), run (`- label | command`, the person chooses what to run).",
  "Elements that need an answer wait for it: after one, stop and wait.",
].join("\n")
