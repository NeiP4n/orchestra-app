// A cheap, dependency-free censor for UI source: it reads the code the agent is about to ship and reports
// the smells that make an interface look generated instead of designed. It is a text scanner, not a parser:
// rules work line by line (the button rule reads a whole element), so a colour split across lines or a value
// assembled at runtime is out of scope. That limit is deliberate — the audit runs on every edit and must not
// need a compiler.

export type UiRule = "no-raw-colors" | "no-emoji-spam" | "semantic-tokens" | "accessible-labels"

export interface UiViolation {
  readonly rule: UiRule
  readonly severity: "error" | "warning"
  readonly line?: number
  readonly message: string
  readonly offending?: string
}

export const REPORT_LIMIT = 2000

const HEX_OR_FUNCTION =
  /(?<![&\w])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})\b|\b(?:rgba?|hsla?)\(/i
const STYLE_CONTEXT =
  /(?:^|[\s{,(])[A-Za-z-]*(?:color|background|fill|stroke|border|bg)[A-Za-z-]*\s*[:=]|\bstyle\s*=|\[#/i
const TAILWIND_ARBITRARY = /\[#[0-9a-fA-F]{3,8}\]/

const NAMED_COLORS = [
  "red",
  "blue",
  "green",
  "white",
  "black",
  "gray",
  "grey",
  "yellow",
  "purple",
  "orange",
  "pink",
  "brown",
  "cyan",
  "magenta",
  "lime",
  "navy",
  "teal",
  "silver",
  "maroon",
  "olive",
  "aqua",
  "fuchsia",
] as const

const NAMED_COLOR = new RegExp(
  `\\b(?:[A-Za-z-]*(?:color|background|fill|stroke|border|bg)[A-Za-z-]*)\\s*[:=]\\s*["'](?:${NAMED_COLORS.join("|")})\\b`,
  "i",
)

const EMOJI_UNIT = /\p{Extended_Pictographic}(?:\uFE0F)?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F)?)*/gu
const SHOUTING = /\[!{3,}\]|!{3,}/g
const BUTTON_OPEN = /<(button|Button)\b/g

interface SourceLine {
  readonly text: string
  readonly line: number
}

export function auditUiCode(code: string, filename?: string): UiViolation[] {
  const lines = code.split(/\r?\n/).map((text, index) => ({ text, line: index + 1 }))
  const jsx = !/\.(?:css|scss|sass|less)$/i.test(filename ?? "")
  return deduplicate([...scanLines(lines, jsx), ...(jsx ? scanButtons(code, lines) : [])])
}

/** Audits only the lines a patch adds, with the line numbers the new file will have. */
export function auditUiDiff(patch: string): UiViolation[] {
  const files = addedLines(patch)
  return deduplicate(
    files.flatMap((file) => {
      const jsx = !/\.(?:css|scss|sass|less)$/i.test(file.name)
      const text = file.lines.map((entry) => entry.text).join("\n")
      return [...scanLines(file.lines, jsx), ...(jsx ? scanButtons(text, file.lines) : [])]
    }),
  )
}

export function formatAuditReport(violations: readonly UiViolation[]): string {
  if (violations.length === 0) return ""
  const lines = [
    `${violations.length} UI violation(s):`,
    ...violations.map((violation) => {
      const where = violation.line === undefined ? "" : `line ${violation.line}: `
      const offending = violation.offending === undefined ? "" : ` ("${clip(violation.offending, 40)}")`
      return `  ${where}${violation.severity} ${violation.rule} — ${violation.message}${offending}`
    }),
  ]
  return clip(lines.join("\n"))
}

function scanLines(lines: readonly SourceLine[], jsx: boolean): UiViolation[] {
  const violations: UiViolation[] = []
  // A style object can span lines (`style={{ background:` then the value), so a styling keyword covers the
  // next five lines as well.
  let styledUntil = -1
  for (const { text, line } of lines) {
    if (isComment(text)) continue
    if (STYLE_CONTEXT.test(text) || TAILWIND_ARBITRARY.test(text)) styledUntil = line + 5
    const styled = !jsx || line <= styledUntil
    violations.push(...scanColors(text, line, styled), ...scanEmoji(text, line), ...scanShouting(text, line))
  }
  return violations
}

function scanColors(text: string, line: number, styled: boolean): UiViolation[] {
  const violations: UiViolation[] = []
  const raw = HEX_OR_FUNCTION.exec(text)
  if (raw !== null && styled) {
    violations.push({
      rule: "no-raw-colors",
      severity: "error",
      line,
      message: "hardcoded colour bypasses the theme; use a semantic token instead",
      offending: raw[0],
    })
  }
  const named = NAMED_COLOR.exec(text)
  if (named !== null) {
    violations.push({
      rule: "semantic-tokens",
      severity: "warning",
      line,
      message: "a CSS colour name bypasses the theme; use a semantic token instead",
      offending: named[0],
    })
  }
  return violations
}

function scanEmoji(text: string, line: number): UiViolation[] {
  const units = [...text.matchAll(EMOJI_UNIT)]
  if (units.length < 2) return []
  let runStart = 0
  for (let index = 1; index <= units.length; index++) {
    const previous = units[index - 1]!
    const current = units[index]
    const joined = current !== undefined && current.index === previous.index + previous[0].length
    if (joined) continue
    const run = units.slice(runStart, index)
    if (run.length >= 2) {
      const start = run[0]!.index
      const end = run[run.length - 1]!.index + run[run.length - 1]![0].length
      return [
        {
          rule: "no-emoji-spam",
          severity: "warning",
          line,
          message: "a run of emoji is UI noise; keep labels as plain text",
          offending: text.slice(start, end),
        },
      ]
    }
    runStart = index
  }
  return []
}

function scanShouting(text: string, line: number): UiViolation[] {
  const match = SHOUTING.exec(text)
  SHOUTING.lastIndex = 0
  if (match === null) return []
  return [
    {
      rule: "no-emoji-spam",
      severity: "warning",
      line,
      message: "a shouting marker is UI noise; state the point in words",
      offending: match[0],
    },
  ]
}

// An icon button is a button whose visible content is only an element: without aria-label or title there is
// nothing a screen reader can announce. The opening tag may span several lines, and so may the content.
function scanButtons(code: string, lines: readonly SourceLine[]): UiViolation[] {
  const violations: UiViolation[] = []
  for (const match of code.matchAll(BUTTON_OPEN)) {
    const start = match.index ?? 0
    const line = lineAt(code, start)
    if (isComment(lines[line - 1]?.text ?? "")) continue
    const name = match[1]!
    const tagEnd = findTagEnd(code, start + match[0].length)
    if (tagEnd === -1) continue
    const tag = code.slice(start, tagEnd + 1)
    if (/\b(?:aria-label|aria-labelledby|title|label|children)\s*=/.test(tag)) continue
    if (/\/>$/.test(tag.trim())) {
      violations.push(emptyButton(line, `${name} ... /`))
      continue
    }
    const closing = code.indexOf(`</${name}`, tagEnd)
    if (closing === -1) continue
    const content = code.slice(tagEnd + 1, closing)
    if (contentVerdict(content) !== "icon") continue
    violations.push(emptyButton(line, tag.replace(/\s+/g, " ").slice(0, 60)))
  }
  return violations
}

// A button whose content is a design-system component may render its own text: only an empty button or one
// that holds nothing but an icon (an element named `Icon`, `XIcon`, `svg`) is an unlabelled icon button.
function contentVerdict(content: string): "text" | "icon" | "unknown" {
  const withoutComments = content.replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, " ")
  if (visibleText(withoutComments) !== "") return "text"
  const elements = [...withoutComments.matchAll(/<\s*([A-Za-z][\w.]*)/g)].map((match) => match[1]!)
  if (elements.length === 0) return "icon"
  return elements.every(isIconName) ? "icon" : "unknown"
}

function isIconName(name: string) {
  if (name === "svg") return true
  return /(?:^|\.)(?:Icon[A-Za-z]*|[A-Za-z]*Icon)$/.test(name)
}

function emptyButton(line: number, offending: string): UiViolation {
  return {
    rule: "accessible-labels",
    severity: "error",
    line,
    message: "an empty button needs text or an aria-label",
    offending,
  }
}

function visibleText(content: string) {
  return content
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\{[^{}]*\}/g, "x")
    .replace(/\s+/g, " ")
    .trim()
}

function findTagEnd(code: string, from: number) {
  let quote = ""
  let depth = 0
  for (let index = from; index < code.length; index++) {
    const char = code[index]!
    if (quote !== "") {
      if (char === quote && code[index - 1] !== "\\") quote = ""
      continue
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char
      continue
    }
    if (char === "{") {
      depth++
      continue
    }
    if (char === "}") {
      depth--
      continue
    }
    if (char === ">" && depth === 0) return index
  }
  return -1
}

function lineAt(code: string, offset: number) {
  let line = 1
  for (let index = 0; index < offset; index++) if (code[index] === "\n") line++
  return line
}

/** Collects added lines per file with the line numbers they will have in the new file. */
function addedLines(patch: string) {
  const files: { name: string; lines: SourceLine[] }[] = []
  let current: { name: string; lines: SourceLine[] } | undefined
  let newLine = 0

  for (const raw of patch.split(/\r?\n/)) {
    if (raw.startsWith("+++ ")) {
      const name = raw.slice(4).replace(/^b\//, "").trim()
      current = name === "/dev/null" ? undefined : { name, lines: [] }
      if (current !== undefined) files.push(current)
      continue
    }
    if (raw.startsWith("--- ") || raw.startsWith("diff ") || raw.startsWith("index ")) continue
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw)
    if (hunk !== null) {
      newLine = Number(hunk[1])
      continue
    }
    if (current === undefined) continue
    if (raw.startsWith("+")) {
      current.lines.push({ text: raw.slice(1), line: newLine })
      newLine++
      continue
    }
    if (raw.startsWith("-")) continue
    newLine++
  }

  return files.filter((file) => file.lines.length > 0)
}

function isComment(text: string) {
  const trimmed = text.trim()
  return trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*") || trimmed.startsWith("{/*")
}

function deduplicate(violations: readonly UiViolation[]) {
  const seen = new Set<string>()
  return violations.filter((violation) => {
    const key = [violation.rule, violation.line, violation.offending].join("|")
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function clip(text: string, limit = REPORT_LIMIT) {
  if (text.length <= limit) return text
  return `${text.slice(0, limit - 24).trimEnd()}\n... (truncated)`
}
