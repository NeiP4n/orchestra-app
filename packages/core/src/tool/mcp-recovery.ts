export * as McpRecovery from "./mcp-recovery.js"

/**
 * Browser-MCP recovery: what a failed snapshot-driven tool call means, and
 * how the wrapper repairs it without spending a model turn.
 *
 * Two failures keep recurring in live chrome-devtools sessions, and both are
 * the server telling the model something it cannot act on as-is:
 *
 * - a stale element: `click`/`fill` with a uid from an older snapshot fails
 *   with "Element with uid 2_66 no longer exists on the page" (or "not
 *   found on page N"). The page changed between take_snapshot and the
 *   action; the uid is dead, retrying it fails again, and the model has to
 *   spend a take_snapshot turn before it can retry. The wrapper instead
 *   takes the fresh snapshot itself and returns it inside the failure, so
 *   the model retries with the new uid in one turn.
 * - a timer inside evaluate: `evaluate` runs without timers, so
 *   `setTimeout` fails with "Unknown identifier 'setTimeout'". There is no
 *   timer to wait for inside the sandbox; the waiting belongs to the
 *   server's `wait_for` tool. The wrapper says so and names it.
 *
 * The same stale-reference shape exists on the other snapshot servers
 * (playwright `browser_snapshot` refs, agent-desktop snapshot refs), so the
 * patterns are server-agnostic: the snapshot/wait tools are discovered by
 * name from whatever the server actually offers, never assumed.
 *
 * Pure, for tests. The only Effect in the flow lives in `tool/mcp.ts`,
 * which calls the snapshot tool and converts the result into a ToolFailure.
 */

export const MAX_SNAPSHOT_CHARS = 20_000

const STALE_ELEMENT_PATTERNS: readonly RegExp[] = [
  // chrome-devtools: "Element with uid 2_66 no longer exists on the page"
  // and 'Element with uid "2_29" not found on page 3'.
  /\buid\b.{0,80}\bno longer exists\b/i,
  /\buid\b.{0,80}\bnot found\b/i,
  /\belement\b.{0,80}\bno longer exists\b/i,
  /\belement\b.{0,80}\bnot found\b/i,
  // playwright / agent-desktop refs: 'Element with ref "e5" not found'.
  /\bref\b.{0,40}\bnot found\b/i,
  /\bstale element\b/i,
]

/** True when the error says the element reference (uid/ref) died with the page. */
export function isStaleElementError(message: string): boolean {
  return STALE_ELEMENT_PATTERNS.some((pattern) => pattern.test(message))
}

const EVALUATE_TOOL = /(^|_)evaluate(_script)?$/i
const TIMER_UNKNOWN = /unknown identifier\s*['"](setTimeout|setInterval)['"]/i
const TIMER_UNDEFINED = /\b(setTimeout|setInterval)\b.{0,40}\bnot defined\b/i

/**
 * The timer the evaluate sandbox rejected, or undefined when this is not a
 * timer-in-evaluate failure. Only evaluate-like tools qualify: a
 * `setTimeout` error anywhere else is a different problem.
 */
export function timerInEvaluateError(tool: string, message: string): "setTimeout" | "setInterval" | undefined {
  if (!EVALUATE_TOOL.test(tool)) return undefined
  const unknown = TIMER_UNKNOWN.exec(message)?.[1]
  if (unknown === "setTimeout" || unknown === "setInterval") return unknown
  const undefinedTimer = TIMER_UNDEFINED.exec(message)?.[1]
  if (undefinedTimer === "setTimeout" || undefinedTimer === "setInterval") return undefinedTimer
  return undefined
}

export type NamedTool = { readonly name: string }

const SNAPSHOT_TOOL_NAMES: readonly string[] = ["take_snapshot", "browser_snapshot", "snapshot", "desktop_snapshot"]

/** The snapshot tool on this server, if it offers one. */
export function snapshotToolName(tools: ReadonlyArray<NamedTool>): string | undefined {
  for (const name of SNAPSHOT_TOOL_NAMES) {
    const found = tools.find((tool) => tool.name === name)
    if (found) return found.name
  }
  return tools.find((tool) => tool.name.toLowerCase().endsWith("snapshot"))?.name
}

/** The wait tool on this server (`wait_for` on chrome-devtools and playwright), if it offers one. */
export function waitToolName(tools: ReadonlyArray<NamedTool>): string | undefined {
  return (
    tools.find((tool) => tool.name === "wait_for")?.name ??
    tools.find((tool) => tool.name.toLowerCase().endsWith("wait_for"))?.name
  )
}

/** True when the tool itself takes a snapshot — a failing snapshot is never "recovered" with another one. */
export function isSnapshotTool(name: string): boolean {
  return name.toLowerCase().endsWith("snapshot")
}

function truncateSnapshot(snapshot: string): string {
  if (snapshot.length <= MAX_SNAPSHOT_CHARS) return snapshot
  const omitted = snapshot.length - MAX_SNAPSHOT_CHARS
  return `${snapshot.slice(0, 15_000)}\n\n[... snapshot truncated: ${omitted} characters omitted to preserve model context ...]\n\n${snapshot.slice(-5_000)}`
}

/**
 * The failure a stale-element error becomes: the original error, the rule
 * (never reuse the old uid/ref), and the fresh snapshot when the wrapper
 * managed to take one — otherwise the name of the snapshot tool to call.
 */
export function staleElementMessage(input: {
  readonly original: string
  readonly snapshotTool?: string
  readonly snapshotText?: string
}): string {
  const lines = [
    `The element you used no longer exists on the page — the page changed since the snapshot it came from, so its uid/ref is stale. Do not reuse the old uid/ref; it will fail again.`,
    "",
    `Original error: ${input.original.trim()}`,
  ]
  if (input.snapshotText !== undefined) {
    lines.push(
      "",
      "Fresh snapshot (taken just now — use ONLY uids/refs from this snapshot):",
      truncateSnapshot(input.snapshotText),
      "",
      "Retry the same action with the new uid/ref for the same element.",
    )
    return lines.join("\n")
  }
  lines.push(
    "",
    input.snapshotTool === undefined
      ? "Take a fresh snapshot first, then retry the same action with the new uid/ref for the same element."
      : `Take a fresh snapshot with ${input.snapshotTool} first, then retry the same action with the new uid/ref for the same element.`,
  )
  return lines.join("\n")
}

/** The failure a timer-in-evaluate error becomes: no timers in evaluate, wait with the server's wait tool. */
export function timerMessage(input: {
  readonly timer: "setTimeout" | "setInterval"
  readonly waitTool?: string
}): string {
  return [
    `evaluate runs without timers: ${input.timer} does not exist inside it. Do not put setTimeout/setInterval (or code that needs them) inside evaluate.`,
    input.waitTool === undefined
      ? "To wait, use the server's wait tool — wait for the text or element you expect — then read the state with a new evaluate call."
      : `To wait, use ${input.waitTool} instead — wait for the text or element you expect — then read the state with a new evaluate call.`,
  ].join("\n")
}
