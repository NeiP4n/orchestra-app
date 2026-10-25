import { Orchestra } from "@orchestra/schema/orchestra"
import { TokenUsage } from "@orchestra/schema/token-usage"

/** What the context panel totals: the routed session, the project that owns it, or the group its project belongs to. */
export type Scope = "session" | "project" | "group"

export const scopes: readonly Scope[] = ["session", "project", "group"]

/** Token kinds in the order the usage bar draws them. */
export const kinds = ["input", "cacheRead", "cacheWrite", "output", "reasoning"] as const

export type Kind = (typeof kinds)[number]

/** The parts of a project the panel reads; the client's plain-string shape, not the schema's branded one. */
export type ProjectRef = { id: string; name: string; directory: string; created: number; main?: string | undefined }

/** The parts of a project group the panel reads. */
export type GroupRef = { name: string; projects: ReadonlyArray<string> }

export type Entry = {
  id: string
  title: string
  tokens: TokenUsage.Info
  cost: number
}

/** One bar segment; `share` is its fraction of the bar's whole (the model's context limit, or the scope's token total). */
export type Segment = { kind: Kind; tokens: number; share: number }

export function tokenKind(tokens: TokenUsage.Info, kind: Kind) {
  if (kind === "cacheRead") return tokens.cache.read

  if (kind === "cacheWrite") return tokens.cache.write

  return tokens[kind]
}

export function emptyTokens(): TokenUsage.Info {
  return { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
}

export function addTokens(a: TokenUsage.Info, b: TokenUsage.Info): TokenUsage.Info {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    reasoning: a.reasoning + b.reasoning,
    cache: { read: a.cache.read + b.cache.read, write: a.cache.write + b.cache.write },
  }
}

/** The non-empty token kinds of `tokens`, each as a share of `whole`. A whole of zero or less yields no segments. */
export function segments(tokens: TokenUsage.Info, whole: number): Segment[] {
  if (whole <= 0) return []

  return kinds.flatMap((kind) => {
    const count = tokenKind(tokens, kind)

    return count > 0 ? [{ kind, tokens: count, share: Math.min(count / whole, 1) }] : []
  })
}

/** The project that owns a session: the one whose main session it is, else the one that opened it, else by directory. */
export function projectOf(input: {
  sessionID: string
  directory: string | undefined
  projects: ReadonlyArray<ProjectRef>
  owners: Readonly<Record<string, string>>
}) {
  return (
    input.projects.find((project) => project.main === input.sessionID) ??
    Orchestra.ownerOf(input.projects, input.directory ?? "", input.owners[input.sessionID])
  )
}

/** The first group that lists the project. A project in no group has none. */
export function groupOf(projectID: string, groups: ReadonlyArray<GroupRef>) {
  return groups.find((group) => group.projects.includes(projectID))
}

/** Sums the entries' tokens and cost. */
export function total(entries: ReadonlyArray<Entry>) {
  return entries.reduce(
    (sum, entry) => ({ tokens: addTokens(sum.tokens, entry.tokens), cost: sum.cost + entry.cost }),
    { tokens: emptyTokens(), cost: 0 },
  )
}

/** Entries from the most to the least tokens, so the heaviest session or project leads the list. */
export function heaviestFirst(entries: ReadonlyArray<Entry>) {
  return entries.toSorted((a, b) => TokenUsage.total(b.tokens) - TokenUsage.total(a.tokens))
}
