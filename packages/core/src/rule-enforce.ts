export * as RuleEnforce from "./rule-enforce.js"

import { appendFileSync, existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

// Enforcement of the rulebook, in two layers.
//
// Hard: a rule written as a directive is checked by code before every tool call and the call is refused with the
// rule's own text. Directives (one per rule, case-insensitive, the rest of the text is free):
//   deny tool <glob> [for role <glob>]          nobody (or that role) calls the tool
//   only role <glob> may use tool <glob>        every other role is refused the tool
//   deny command <regex> [for role <glob>]      shell commands matching the regex
//   deny path <glob> [for role <glob>]          file tools whose path matches the glob
// Soft: the other rules are read by a light judge at the end of a turn (see judgePrompt), which sends the session
// back to work with the rule quoted.
// Every refusal and every judged violation is written to ~/orchestra-rule-violations.log.

export interface Entry {
  readonly title: string
  readonly text: string
  readonly by: string
}

export const LOG = () => join(homedir(), "orchestra-rule-violations.log")
export const JUDGE_KEY = "orchestra:rule-judge"
export const JUDGE_MAX = 2
/** The rulebook tool itself is never refused: a session must always be able to read and fix its rules. */
const EXEMPT = new Set(["rules", "question"])

const active = new Map<string, ReadonlyArray<Entry>>()
/** The rules a session carried on its latest request (set by the context hook, read by the tool hook and the judge). */
export const remember = (sessionID: string, entries: ReadonlyArray<Entry>) => {
  active.set(sessionID, entries)
  if (active.size > 500) active.delete(active.keys().next().value as string)
}
export const recall = (sessionID: string): ReadonlyArray<Entry> => active.get(sessionID) ?? []

const glob = (pattern: string) =>
  new RegExp(`^${pattern.trim().replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`, "i")

const roleMatches = (pattern: string, agent: string) => {
  const re = glob(pattern)
  return re.test(agent) || re.test(agent.replace(/^team-/, ""))
}

type Directive =
  | { kind: "tool"; tool: string; role?: string }
  | { kind: "only"; tool: string; role: string }
  | { kind: "command"; pattern: RegExp; role?: string }
  | { kind: "path"; path: string; role?: string }

const FOR_ROLE = /\s+for\s+role\s+(\S+)\s*\.?$/i

export const parse = (text: string): Directive | undefined => {
  const raw = text.trim()
  let match = /^only\s+role\s+(\S+)\s+may\s+use\s+tool\s+(\S+?)\.?$/i.exec(raw)
  if (match) return { kind: "only", role: match[1]!, tool: match[2]! }
  const roleMatch = FOR_ROLE.exec(raw)
  const role = roleMatch?.[1]
  const body = roleMatch ? raw.slice(0, roleMatch.index) : raw.replace(/\.$/, "")
  match = /^deny\s+tool\s+(\S+)$/i.exec(body)
  if (match) return { kind: "tool", tool: match[1]!, ...(role ? { role } : {}) }
  match = /^deny\s+path\s+(\S+)$/i.exec(body)
  if (match) return { kind: "path", path: match[1]!, ...(role ? { role } : {}) }
  match = /^deny\s+command\s+(.+)$/i.exec(body)
  if (match) {
    try {
      return { kind: "command", pattern: new RegExp(match[1]!.trim(), "i"), ...(role ? { role } : {}) }
    } catch {
      return undefined
    }
  }
  return undefined
}

export const isDirective = (text: string) => parse(text) !== undefined

const pathsOf = (input: unknown): string[] => {
  if (typeof input !== "object" || input === null) return []
  const record = input as Record<string, unknown>
  return ["path", "filePath", "file_path", "file", "paths"].flatMap((key) => {
    const value = record[key]
    return typeof value === "string" ? [value] : Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
  })
}

/** The first directive among `entries` that forbids this call, or undefined. Operator rules are checked first. */
export const violation = (
  entries: ReadonlyArray<Entry>,
  call: { tool: string; agent: string; input: unknown },
): Entry | undefined => {
  if (EXEMPT.has(call.tool)) return undefined
  const ordered = [...entries].sort((a, b) => Number(b.by === "operator") - Number(a.by === "operator"))
  const command =
    typeof call.input === "object" && call.input !== null && typeof (call.input as { command?: unknown }).command === "string"
      ? String((call.input as { command: string }).command)
      : undefined
  for (const entry of ordered) {
    const directive = parse(entry.text)
    if (!directive) continue
    const forRole = "role" in directive && directive.role !== undefined
    switch (directive.kind) {
      case "only":
        if (glob(directive.tool).test(call.tool) && !roleMatches(directive.role, call.agent)) return entry
        break
      case "tool":
        if (glob(directive.tool).test(call.tool) && (!forRole || roleMatches(directive.role!, call.agent))) return entry
        break
      case "command":
        if (command !== undefined && directive.pattern.test(command) && (!forRole || roleMatches(directive.role!, call.agent)))
          return entry
        break
      case "path":
        if (pathsOf(call.input).some((item) => glob(directive.path).test(item.replaceAll("\\", "/"))) && (!forRole || roleMatches(directive.role!, call.agent)))
          return entry
        break
    }
  }
  return undefined
}

export const refusal = (entry: Entry) =>
  `Rule check: this call is refused by a standing rule (${entry.by === "operator" ? "set by the operator" : `by ${entry.by}`}, ${entry.title}): "${entry.text}". Do it another way that keeps the rule, or ask the Orchestrator or the operator to change the rule.`

export interface Logged {
  readonly layer: "hard" | "soft"
  readonly outcome: "refused" | "sent-back" | "passed"
  readonly session: string
  readonly agent: string
  readonly rule?: string
  readonly by?: string
  readonly what: string
}

export const log = (item: Logged) => {
  try {
    appendFileSync(LOG(), JSON.stringify({ ts: new Date().toISOString(), ...item, what: item.what.slice(0, 300) }) + "\n")
  } catch {}
}

/** The newest logged violations, newest last, as short readable lines. */
export const recent = (count = 15): string[] => {
  try {
    if (!existsSync(LOG())) return []
    return readFileSync(LOG(), "utf8")
      .split("\n")
      .filter(Boolean)
      .slice(-count)
      .map((line) => {
        try {
          const row = JSON.parse(line) as Logged & { ts: string }
          return `${row.ts} ${row.layer} ${row.outcome} ${row.agent} ${row.rule ? `rule "${row.rule}"` : ""} :: ${row.what}`
        } catch {
          return line.slice(0, 200)
        }
      })
  } catch {
    return []
  }
}

export const JUDGE_SYSTEM =
  "You check an AI agent's finished turn against the standing rules of its crew. Reply with ONE line only. " +
  "If the turn broke a rule, reply: VIOLATION <rule number>: <what broke it, at most 20 words>. " +
  "Otherwise reply: OK. Operator rules come first and win over any other rule. Only flag a clear break, never a doubt, " +
  "and never a rule the turn did not touch."

export const judgePrompt = (entries: ReadonlyArray<Entry>, turn: string) =>
  [
    "Rules:",
    ...entries.map((entry, index) => `${index + 1}. [${entry.by === "operator" ? "operator" : entry.title}] ${entry.text}`),
    "",
    "The agent's turn (its calls and its last reply):",
    turn,
  ].join("\n")

/** The rule a judge line points at, or undefined when the line says OK or cannot be read. */
export const verdict = (line: string | undefined, entries: ReadonlyArray<Entry>): { entry: Entry; why: string } | undefined => {
  const match = /^\s*VIOLATION\s+#?(\d+)\s*[:\-]\s*(.*)$/i.exec(line ?? "")
  if (!match) return undefined
  const entry = entries[Number(match[1]) - 1]
  return entry ? { entry, why: match[2]!.trim().slice(0, 200) } : undefined
}

/**
 * Built-in checks that hold without anyone writing a rule: the browser belongs to the BrowserAgent. A subagent or a
 * Code Mode script that hands page work to another role, or starts a browser of its own, is refused. Returns the
 * refusal text, or undefined.
 */
export const builtin = (
  call: { tool: string; agent: string; input: unknown },
  browserTask: RegExp,
): string | undefined => {
  const input = typeof call.input === "object" && call.input !== null ? (call.input as Record<string, unknown>) : {}
  const route =
    "Page work goes to the BrowserAgent of the browser session: browser action=sessions shows its chat id, then sessions send there. Do not hand it to another role, a subagent or a script."
  if (call.tool === "subagent") {
    const target = String(input.agent ?? "").replace(/^team-/, "")
    if (target !== "browser-agent" && typeof input.prompt === "string" && browserTask.test(input.prompt)) return route
  }
  // A browser role is the BrowserAgent of a browser session (a record and a page in the Browser tab). A role or a
  // session made with a browser-like name and no page would be a plain chat dressed as one.
  const browserLike = (value: unknown) => typeof value === "string" && /browser/i.test(value) && !/^(?:team-)?browser-agent$/.test(value.trim())
  const nonBrowserAgent = "A role or session named for the browser is refused: browser work belongs to the BrowserAgent of a browser session (browser action=sessions lists them). To add one, use sessions action=create role=browser-agent with a title that names the task or site; it appears in Browsers. Do not make browser sessions with another role or a \"Browser N\" title."
  // Any way to start a browser-named agent: the subagent tool, sessions create, a role or a team member.
  if (call.tool === "subagent" && browserLike(input.agent)) return nonBrowserAgent
  if (call.tool === "team_forge" && (input.action === "team" || input.action === "edit_team") && Array.isArray(input.members) && input.members.some((member) => typeof member === "object" && member !== null && browserLike((member as Record<string, unknown>).role)))
    return nonBrowserAgent
  if (call.tool === "team_forge" && (input.action === "role" || input.action === "edit_role") && (browserLike(input.name) || browserLike(input.id)))
    return nonBrowserAgent
  if (call.tool === "sessions" && input.action === "create" && (browserLike(input.role) || (!/^(?:team-)?browser-agent$/.test(String(input.role ?? "").trim()) && /^\s*browser(?:\s+session)?(?:\s*\d+)?\s*$/i.test(String(input.title ?? "")))))
    return nonBrowserAgent
  if (call.tool === "execute" && typeof input.code === "string") {
    const code = input.code
    if (/(?:playwright|puppeteer|selenium|chromedriver|msedge|chrome\.exe|google-chrome)/i.test(code) && /(?:spawn|exec|launch|import|require|npx|bunx|Bun\.\$)/i.test(code))
      return "Starting a browser from a script is refused: the browser tool and the Browser tab are the only browser."
    // A script that names a browser-like role for sessions create, subagent or team_forge.
    if (/\b(?:sessions|subagent|team_forge)\b/.test(code) && /(?:role|agent|name|id)["']?\s*[:=]\s*["'`](?!(?:team-)?browser-agent["'`])[^"'`]*browser/i.test(code)) return nonBrowserAgent
    if (/\b(?:sessions|subagent)\b/.test(code) && /\b(?:create|send)\b|\bagent\b/.test(code) && browserTask.test(code)) return route
  }
  return undefined
}
