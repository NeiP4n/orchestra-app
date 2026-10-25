import { Orchestra } from "@orchestra/schema/orchestra"
import type { SessionMessageInfo } from "@orchestra/client"
import { lastAssistantWithUsage } from "./session"

/** What the sidebar's Context block totals: this session, the project that owns it, or the project's group. */
export type Scope = "session" | "project" | "group"

export const scopes: readonly Scope[] = ["session", "project", "group"]

/** Token kinds in the order the bar draws them, each with its own glyph so the bar reads without color. */
export const kinds = [
  { id: "input", label: "Input", glyph: "█" },
  { id: "cacheRead", label: "Cache read", glyph: "▓" },
  { id: "cacheWrite", label: "Cache write", glyph: "▒" },
  { id: "output", label: "Output", glyph: "▞" },
  { id: "reasoning", label: "Reasoning", glyph: "▚" },
] as const
export type Kind = (typeof kinds)[number]["id"]

export type Tokens = Readonly<Record<Kind, number>>

/** The parts of a project the Context block reads. */
export type ProjectRef = { id: string; name: string; directory: string; created: number; main?: string | undefined }

/** One session, or one project's sessions together. */
export type Entry = { id: string; title: string; tokens: Tokens; cost: number }

/** What the scope shows: the entries to list, or why there are none. */
export type Loaded =
  | { state: "no-project" }
  | { state: "no-group"; project: string }
  | { state: "ready"; title: string; entries: Entry[] }

export function emptyTokens(): Tokens {
  return { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 }
}

export function tokensOf(tokens: {
  input: number
  output: number
  reasoning: number
  cache: { read: number; write: number }
}): Tokens {
  return {
    input: tokens.input,
    cacheRead: tokens.cache.read,
    cacheWrite: tokens.cache.write,
    output: tokens.output,
    reasoning: tokens.reasoning,
  }
}

export function sumOf(tokens: Tokens) {
  return kinds.reduce((count, kind) => count + tokens[kind.id], 0)
}

/** The tokens the session's latest request held, by kind: what fills its context window now. */
export function contextBreakdown(messages: ReadonlyArray<SessionMessageInfo>, boundary?: string) {
  const last = lastAssistantWithUsage(messages, boundary)
  return last ? tokensOf(last.tokens) : undefined
}

/** Sums the entries' tokens and cost. */
export function total(entries: ReadonlyArray<Entry>) {
  return entries.reduce(
    (sum, entry) => ({
      tokens: Object.fromEntries(kinds.map((kind) => [kind.id, sum.tokens[kind.id] + entry.tokens[kind.id]])) as Tokens,
      cost: sum.cost + entry.cost,
    }),
    { tokens: emptyTokens(), cost: 0 },
  )
}

/** Entries from the most to the least tokens, so the heaviest session or project leads. */
export function heaviestFirst(entries: ReadonlyArray<Entry>) {
  return entries.toSorted((a, b) => sumOf(b.tokens) - sumOf(a.tokens))
}

/** The project that owns a session: its main session's project, else the one that opened it, else by directory. */
export function projectOf(input: {
  sessionID: string
  directory: string | undefined
  projects: ReadonlyArray<ProjectRef>
  owner: string | undefined
}) {
  return (
    input.projects.find((project) => project.main === input.sessionID) ??
    Orchestra.ownerOf(input.projects, input.directory ?? "", input.owner)
  )
}

/** The first group that lists the project. */
export function groupOf<T extends { projects: ReadonlyArray<string> }>(projectID: string, groups: ReadonlyArray<T>) {
  return groups.find((group) => group.projects.includes(projectID))
}

/**
 * Splits a bar of `width` cells among the token kinds as shares of `whole`. Every non-empty kind gets at least one
 * cell while there is room, and the cells never exceed the width.
 */
export function barCells(tokens: Tokens, whole: number, width: number) {
  if (whole <= 0 || width <= 0) return []
  const cells = kinds.flatMap((kind) => {
    const count = tokens[kind.id]
    return count > 0 ? [{ kind, cells: Math.max(1, Math.round((count / whole) * width)) }] : []
  })
  let excess = cells.reduce((count, item) => count + item.cells, 0) - width
  // Rounding up the small kinds can overshoot: take the surplus back from the widest.
  while (excess > 0) {
    const widest = cells.reduce((best, item) => (item.cells > best.cells ? item : best), cells[0]!)
    if (widest.cells <= 1) break
    widest.cells -= 1
    excess -= 1
  }
  return cells
}
