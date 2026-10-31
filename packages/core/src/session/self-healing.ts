// A failure the agent can act on, parsed from the text a check prints: TypeScript/tsgo errors, failing
// bun/vitest tests together with the assertion that failed, and runtime or syntax errors with a location.
// The module is pure so the healing loop can be tested against captured output instead of a live compiler.

export type DiagnosticKind = "typescript" | "test" | "syntax" | "runtime" | "unknown"

export interface Diagnostic {
  readonly kind: DiagnosticKind
  readonly message: string
  readonly file?: string
  readonly line?: number
  readonly column?: number
  /** Compiler code such as TS2322. */
  readonly code?: string
  readonly expected?: string
  readonly actual?: string
}

export const SUMMARY_LIMIT = 2000
const SUMMARY_LINES = 10

// `src/a.ts(12,5): error TS2322: ...` is what tsgo and tsc print; `src/a.ts:12:5 - error TS2322: ...` is the
// older tsc format. The path is lazy so a Windows drive letter and a path with spaces both survive.
const TS_PARENTHESIS = /^(?<file>.+?)\((?<line>\d+),(?<column>\d+)\):\s*error\s+(?<code>TS\d+):\s*(?<message>.+)$/
const TS_DASH = /^(?<file>.+?):(?<line>\d+):(?<column>\d+)\s+-\s*error\s+(?<code>TS\d+):\s*(?<message>.+)$/
const BUN_FAIL = /^\(fail\)\s+(?<name>.+?)(?:\s+\[\d+(?:\.\d+)?\s*(?:ms|s)\])?$/
const VITEST_FAIL = /^FAIL\s+(?<file>\S+)\s*>\s*(?<name>.+)$/
const VITEST_ASSERTION = /^AssertionError:\s*(?<message>.+)$/
const ERROR_LINE = /^error:\s*(?<message>.+)$/
const EXPECTED = /^\s*Expected(?<verb>(?:\s+to\s+[A-Za-z ]+?)?):\s*(?<value>.*)$/
const RECEIVED = /^\s*Received:\s*(?<value>.*)$/
const LOCATION = /(?<file>(?:[A-Za-z]:[\\/]|\/)?[^\s()]+):(?<line>\d+):(?<column>\d+)\)?\s*$/
const SOURCE_FRAME = /^\s*\d+\s*\|/
const SUMMARY_LINE = /^\s*\d+\s+(?:pass|fail|skip|todo|expect\(\) calls)\b/

interface MutableDiagnostic {
  kind: DiagnosticKind
  message: string
  file?: string
  line?: number
  column?: number
  code?: string
  expected?: string
  actual?: string
}

export function parseDiagnostics(rawOutput: string): Diagnostic[] {
  const diagnostics: MutableDiagnostic[] = []
  let current: MutableDiagnostic | undefined
  let lastWasLocation = false

  for (const line of rawOutput.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === "") {
      lastWasLocation = false
      continue
    }
    if (SUMMARY_LINE.test(line) || SOURCE_FRAME.test(line)) continue

    const compiler = TS_PARENTHESIS.exec(trimmed) ?? TS_DASH.exec(trimmed)
    if (compiler?.groups) {
      const code = compiler.groups.code!
      current = {
        kind: code.startsWith("TS1") ? "syntax" : "typescript",
        message: compiler.groups.message!.trim(),
        file: normalize(compiler.groups.file!),
        line: Number(compiler.groups.line),
        column: Number(compiler.groups.column),
        code,
      }
      diagnostics.push(current)
      lastWasLocation = false
      continue
    }

    const bunFail = BUN_FAIL.exec(trimmed)
    if (bunFail?.groups) {
      const testName = bunFail.groups.name!.trim()
      const pending = diagnostics[diagnostics.length - 1]
      // bun prints the assertion block first and the `(fail)` line under it; the name belongs to that block.
      if (
        pending !== undefined &&
        pending.kind === "test" &&
        (pending.message === "expectation failed" || pending.message === "")
      ) {
        pending.message = testName
        current = pending
      } else {
        current = { kind: "test", message: testName }
        diagnostics.push(current)
      }
      lastWasLocation = false
      continue
    }

    const vitestFail = VITEST_FAIL.exec(trimmed)
    if (vitestFail?.groups) {
      current = { kind: "test", message: vitestFail.groups.name!.trim(), file: normalize(vitestFail.groups.file!) }
      diagnostics.push(current)
      lastWasLocation = false
      continue
    }

    const expected = EXPECTED.exec(line)
    if (expected?.groups) {
      current = current ?? push(diagnostics, { kind: "test", message: "expectation failed" })
      const verb = (expected.groups.verb ?? "").trim()
      const value = expected.groups.value!.trim()
      current.expected = verb === "" ? value : `${verb.replace(/^to\s+/i, "")}: ${value}`
      lastWasLocation = false
      continue
    }

    const received = RECEIVED.exec(line)
    if (received?.groups) {
      current = current ?? push(diagnostics, { kind: "test", message: "expectation failed" })
      current.actual = received.groups.value!.trim()
      lastWasLocation = false
      continue
    }

    const assertion = VITEST_ASSERTION.exec(trimmed)
    if (assertion?.groups) {
      const parsed = parseExpectation(assertion.groups.message!)
      current = current ?? push(diagnostics, { kind: "test", message: assertion.groups.message!.trim() })
      if (current.kind === "test" && current.message === "expectation failed")
        current.message = assertion.groups.message!.trim()
      if (parsed.expected !== undefined) current.expected = parsed.expected
      if (parsed.actual !== undefined) current.actual = parsed.actual
      lastWasLocation = false
      continue
    }

    const location = LOCATION.exec(trimmed)
    if (location?.groups && (lastWasLocation === false || current?.file === undefined)) {
      const found = {
        file: normalize(location.groups.file!),
        line: Number(location.groups.line),
        column: Number(location.groups.column),
      }
      if (current === undefined) {
        current = push(diagnostics, { kind: "runtime", message: "the check failed without an error message", ...found })
      } else {
        current.file = current.file ?? found.file
        current.line = current.line ?? found.line
        current.column = current.column ?? found.column
      }
      lastWasLocation = true
      continue
    }

    const errorLine = ERROR_LINE.exec(trimmed)
    if (errorLine?.groups) {
      const message = errorLine.groups.message!.trim()
      // An assertion failure arrives as `error: expect(...)`; the test name follows on its own `(fail)` line.
      if (/^expect\(/.test(message)) {
        if (current?.kind !== "test") current = push(diagnostics, { kind: "test", message: "expectation failed" })
        lastWasLocation = false
        continue
      }
      current = { kind: classification(message, current), message }
      diagnostics.push(current)
      lastWasLocation = false
      continue
    }

    // Indented text after a diagnostic is part of its message; anything else is noise from the runner.
    if (current !== undefined && /^\s{2,}\S/.test(line) && !lastWasLocation) {
      current.message = `${current.message} ${trimmed}`.trim()
    }
  }

  return deduplicate(diagnostics.map(freeze))
}

/** Compact text for the agent: what broke, where, and what the assertion wanted. */
export function summarize(diagnostics: readonly Diagnostic[]): string {
  if (diagnostics.length === 0) return "The check printed no diagnostic; read the full output to find the failure."
  const counts = new Map<string, number>()
  for (const diagnostic of diagnostics) counts.set(diagnostic.kind, (counts.get(diagnostic.kind) ?? 0) + 1)
  const shape = [...counts].map(([kind, count]) => `${count} ${kind}`).join(", ")

  const lines = [
    `${diagnostics.length} diagnostic(s): ${shape}`,
    ...diagnostics.slice(0, SUMMARY_LINES).map(describe),
    ...(diagnostics.length > SUMMARY_LINES ? [`... and ${diagnostics.length - SUMMARY_LINES} more`] : []),
  ]
  return clip(lines.join("\n"))
}

export interface HealingContext {
  readonly diagnostics: readonly Diagnostic[]
  readonly attempt: number
  readonly maxAttempts: number
  readonly canRetry: boolean
  readonly shouldRollback: boolean
  readonly summary: string
  readonly prompt: string
}

export interface HealingParams {
  readonly diagnostics: readonly Diagnostic[]
  /** Checkpoint of the tree before the attempt, so an exhausted loop can roll back. */
  readonly checkpointId?: string
  /** 1 for the first repair attempt. */
  readonly attempt: number
  readonly maxAttempts: number
}

export function createHealingContext(params: HealingParams): HealingContext {
  if (!Number.isInteger(params.attempt) || params.attempt < 1)
    throw new RangeError(`attempt must be a positive integer, got ${params.attempt}`)
  if (!Number.isInteger(params.maxAttempts) || params.maxAttempts < 1)
    throw new RangeError(`maxAttempts must be a positive integer, got ${params.maxAttempts}`)

  const checkpoint = params.checkpointId?.trim() ?? ""
  const summary = summarize(params.diagnostics)
  const canRetry = params.attempt < params.maxAttempts && params.diagnostics.length > 0
  const shouldRollback = !canRetry && checkpoint !== ""

  const prompt = [
    canRetry
      ? `The check failed on attempt ${params.attempt} of ${params.maxAttempts}.`
      : `The check failed on the last attempt (${params.attempt} of ${params.maxAttempts}).`,
    "",
    summary,
    "",
    canRetry ? repairInstructions(checkpoint) : stopInstructions(checkpoint),
  ].join("\n")

  return {
    diagnostics: params.diagnostics,
    attempt: params.attempt,
    maxAttempts: params.maxAttempts,
    canRetry,
    shouldRollback,
    summary,
    prompt,
  }
}

function repairInstructions(checkpoint: string) {
  return [
    "Repair the cause, not the symptom:",
    "1. Read the file at the reported location and the code around it before editing.",
    "2. Change the implementation. Never delete a test, skip a case, loosen an assertion or edit an expected value to make the check pass.",
    "3. Re-run exactly the command that produced this output and compare the new output with the old one.",
    "4. If the same error returns after a real fix attempt, change the approach instead of repeating the edit.",
    ...(checkpoint === ""
      ? []
      : [
          `5. If the tree is now worse than before the attempt, restore checkpoint "${checkpoint}" with the checkpoint tool (action "restore") instead of editing backwards.`,
        ]),
  ].join("\n")
}

function stopInstructions(checkpoint: string) {
  return [
    "The attempt budget is spent. Stop editing and report honestly:",
    ...(checkpoint === ""
      ? [
          "- Say what is still broken and what you changed, so a human can take over.",
          "- Do not claim the check passes.",
        ]
      : [
          `- Restore checkpoint "${checkpoint}" with the checkpoint tool (action "restore") to return the project to its last good state.`,
          "- Then say what is still broken and what you changed, so a human can take over.",
        ]),
  ].join("\n")
}

function parseExpectation(message: string) {
  const match = /^expected\s+(?<actual>.+?)\s+to\s+(?:be|equal|deeply equal)\s+(?<expected>.+)$/i.exec(message.trim())
  if (match?.groups) return { actual: match.groups.actual!.trim(), expected: match.groups.expected!.trim() }
  return {}
}

function classification(message: string, current: MutableDiagnostic | undefined): DiagnosticKind {
  if (/^(Expected|Unexpected)\b.*\b(but found|token|end of file)\b/i.test(message)) return "syntax"
  if (current?.kind === "test") return "test"
  if (/Cannot find module|MODULE_NOT_FOUND|is not a function|is not defined|TypeError|ReferenceError/i.test(message))
    return "runtime"
  return "unknown"
}

function push(diagnostics: MutableDiagnostic[], diagnostic: MutableDiagnostic) {
  diagnostics.push(diagnostic)
  return diagnostic
}

function freeze(diagnostic: MutableDiagnostic): Diagnostic {
  return {
    kind: diagnostic.kind,
    message: diagnostic.message.trim(),
    ...(diagnostic.file === undefined ? {} : { file: diagnostic.file }),
    ...(diagnostic.line === undefined ? {} : { line: diagnostic.line }),
    ...(diagnostic.column === undefined ? {} : { column: diagnostic.column }),
    ...(diagnostic.code === undefined ? {} : { code: diagnostic.code }),
    ...(diagnostic.expected === undefined ? {} : { expected: diagnostic.expected }),
    ...(diagnostic.actual === undefined ? {} : { actual: diagnostic.actual }),
  }
}

function deduplicate(diagnostics: readonly Diagnostic[]) {
  const seen = new Set<string>()
  return diagnostics.filter((diagnostic) => {
    const key = [
      diagnostic.kind,
      diagnostic.file,
      diagnostic.line,
      diagnostic.column,
      diagnostic.code,
      diagnostic.message,
    ].join("|")
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function describe(diagnostic: Diagnostic) {
  const where =
    diagnostic.file === undefined
      ? ""
      : `${diagnostic.file}${diagnostic.line === undefined ? "" : `:${diagnostic.line}${diagnostic.column === undefined ? "" : `:${diagnostic.column}`}`} `
  const code = diagnostic.code === undefined ? "" : `${diagnostic.code} `
  const detail =
    diagnostic.expected === undefined
      ? diagnostic.message
      : `${diagnostic.message} (expected ${diagnostic.expected}, received ${diagnostic.actual ?? "nothing"})`
  return `  ${where}${code}${detail}`.trimEnd()
}

function normalize(file: string) {
  return file.replaceAll("\\", "/")
}

function clip(text: string, limit = SUMMARY_LIMIT) {
  if (text.length <= limit) return text
  return `${text.slice(0, limit - 24).trimEnd()}\n... (truncated)`
}
