export * as Rules from "./rules.js"

import { RuleEnforce } from "./rule-enforce.js"

import { Cause, Effect, Option, Schema } from "effect"
import { SessionID } from "@orchestra/schema/session-id"
import type { Federation } from "./federation.js"
import type { Orchestra } from "./orchestra.js"
import type { Session } from "./session.js"
import type { KV } from "./kv.js"
import { Federation as FederationSchema } from "@orchestra/schema/federation"

// The rulebook: short standing rules the AIs of a project or a Society keep. An AI adds a rule when it learns
// something the whole crew must follow (a convention, a thing never to do, a decision that settles a debate); the
// operator reads, edits and deletes them. Every request of a session carries the rules that apply to it, so a rule
// costs a few tokens once and binds everyone, where repeating it in each brief costs them on every task.
//
// Scopes: `global` (every session), `project:<id>` (one project's team), `society:<name>` (the Society's chat
// and every project of the Society, which is what makes a Society run differently from a lone project).
//
// Rules are checked by code, not by asking the model nicely:
// - a scope that cannot be loaded fails the load instead of reading as empty;
// - a rule the operator wrote can only be removed by the operator, in any scope;
// - a lower scope never silently overrides a higher one: society > project > global,
//   and a contradiction between scopes is an error, not a judgement call.
export interface Rule {
  readonly id: string
  readonly text: string
  /** Who wrote it: "operator", or the AI's project and role. */
  readonly by: string
  readonly at: number
}

export const MAX_PER_SCOPE = 20
export const MAX_TEXT = 240

const KEY = "rules/"
const HISTORY_KEY = "rules/history/"
const HISTORY_CAP = 100

export const GLOBAL = "global"
export const projectScope = (id: string) => `project:${id}`
/** Independent, editable copy of defaults, initialized atomically including an empty copy. */
export const projectDefaultsScope = (id: string) => `project-defaults:${id}`
export const societyDefaultsScope = (name: string) => `society-defaults:${name}`
const snapshotScope = (kv: KV.Interface, scope: string) => Effect.gen(function* () {
  if ((yield* kv.get(KEY + scope)) !== undefined) return
  const defaults = yield* listStrict(kv, GLOBAL)
  yield* kv.atomicUpdate(KEY + scope, (current) => current === undefined ? defaults as unknown as KV.Value : current)
})
export const snapshotDefaults = (kv: KV.Interface, projectID: string) => snapshotScope(kv, projectDefaultsScope(projectID))
export const snapshotSocietyDefaults = (kv: KV.Interface, name: string) => snapshotScope(kv, societyDefaultsScope(name))

export const societyScope = (name: string) => `society:${name}`
/** Rules the operator puts on a project's Orchestrator: it gets them every turn; nobody but the operator removes them. */
export const orchestratorScope = (project: string) => `orchestrator:${project}`
/** Rules for one role (agent name) of a project: only sessions of that role carry them. The Orchestrator hands them out. */
export const roleScope = (project: string, role: string) => `role:${project}:${role}`
/** Rules for one session: only that session carries them. */
export const sessionScope = (id: string) => `session:${id}`

/** A scope's stored rules could not be read, or some of its stored entries are corrupt. */
export class LoadError extends Schema.TaggedError<LoadError>()("Rules.LoadError", {
  scope: Schema.String,
  reason: Schema.String,
}) {}

/** Two scopes contradict each other. The model never picks a winner. */
export class ConflictError extends Schema.TaggedError<ConflictError>()("Rules.ConflictError", {
  reason: Schema.String,
}) {}

/** The session's scopes could not be determined, so no rule can be trusted to apply. */
export class ScopesError extends Schema.TaggedError<ScopesError>()("Rules.ScopesError", {
  reason: Schema.String,
}) {}

/** A worker tried to remove or rewrite a rule the operator wrote. */
export class ProtectedError extends Schema.TaggedError<ProtectedError>()("Rules.ProtectedError", {
  reason: Schema.String,
}) {}

const isRule = (item: unknown): item is Rule =>
  typeof item === "object" &&
  item !== null &&
  typeof (item as Partial<Rule>).id === "string" &&
  typeof (item as Partial<Rule>).text === "string"

/** The failure value a cause carries, or undefined when it died or was interrupted. */
const failureOf = (cause: Cause.Cause<unknown>): unknown =>
  Option.getOrUndefined(Cause.findErrorOption(cause))

const toRule = (item: Partial<Rule>): Rule => ({
  id: item.id as string,
  text: item.text as string,
  by: String(item.by ?? "operator"),
  at: Number(item.at ?? 0),
})

// Two defaults that made the AI ask the operator how to solve a task (three questions before code, a read-only
// "questions only" phase) were removed from DEFAULT_SOCIETY_RULES. Societies seeded earlier still store them, so a
// stored rule with exactly one of these texts, seeded by "operator", is no longer loaded.
const LEGACY_DEFAULTS: ReadonlySet<string> = new Set([
  "Before writing code for a task, first write exactly 3 questions about what is unclear in it, then work from the answers.",
  "The first 30 minutes of a sprint are reading code and asking questions only; writing code is forbidden until the read-only phase ends.",
])

/** The stored rules of a scope plus how many stored entries are corrupt and were skipped. */
export const inspect = (kv: KV.Interface, scope: string): Effect.Effect<{ rules: ReadonlyArray<Rule>; corrupt: number }> =>
  kv.get(KEY + scope).pipe(
    Effect.map((value) => {
      if (value === undefined) return { rules: [], corrupt: 0 }
      if (!Array.isArray(value)) return { rules: [], corrupt: 1 }
      const rules: Rule[] = []
      let corrupt = 0
      for (const item of value) {
        if (isRule(item)) {
          const rule = toRule(item)
          if (!(rule.by === "operator" && LEGACY_DEFAULTS.has(rule.text))) rules.push(rule)
        } else corrupt++
      }
      return { rules, corrupt }
    }),
  )

// Display only: corrupt entries are skipped, and the caller must say so (see `inspect`).
// Anything that acts on rules — the system-prompt block, add, remove — uses `listStrict`.
export const list = (kv: KV.Interface, scope: string): Effect.Effect<ReadonlyArray<Rule>> =>
  inspect(kv, scope).pipe(Effect.map((found) => found.rules))

/** The stored rules of a scope, failing loudly when the scope cannot be read or holds corrupt entries. */
export const listStrict = (kv: KV.Interface, scope: string): Effect.Effect<ReadonlyArray<Rule>, LoadError> =>
  inspect(kv, scope).pipe(
    Effect.flatMap((found) =>
      found.corrupt > 0
        ? Effect.fail(
            new LoadError({
              scope,
              reason: `${found.corrupt} stored rule ${found.corrupt === 1 ? "entry is" : "entries are"} corrupt and were not loaded; fix the scope before the rules can be trusted.`,
            }),
          )
        : Effect.succeed(found.rules),
    ),
    Effect.catchCause((cause) => {
      // An interruption keeps interrupting; turning it into a load error would let a stopped session keep working.
      if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause)
      const error = failureOf(cause)
      return Effect.fail(
        error instanceof LoadError
          ? error
          : new LoadError({
              scope,
              reason: `could not be read: ${error === undefined ? Cause.pretty(cause) : String(error)}`,
            }),
      )
    }),
  )

interface HistoryEntry {
  readonly action: "add" | "remove"
  readonly id: string
  readonly text: string
  readonly by: string
  readonly at: number
}

// Every edit to a scope is recorded next to it, so a rule nobody remembers writing can be traced.
const recordHistory = (kv: KV.Interface, scope: string, entry: HistoryEntry) =>
  Effect.gen(function* () {
    const key = HISTORY_KEY + scope
    const stored = yield* kv.get(key).pipe(Effect.orElseSucceed(() => undefined))
    const entries = (Array.isArray(stored) ? stored : []).filter(
      (item): item is HistoryEntry =>
        typeof item === "object" && item !== null && typeof (item as Partial<HistoryEntry>).id === "string",
    )
    yield* kv.set(key, [...entries, entry].slice(-HISTORY_CAP) as unknown as KV.Value)
  }).pipe(Effect.orElseSucceed(() => undefined))

export const history = (kv: KV.Interface, scope: string): Effect.Effect<ReadonlyArray<HistoryEntry>> =>
  kv.get(HISTORY_KEY + scope).pipe(
    Effect.map((stored) =>
      Array.isArray(stored)
        ? stored.filter(
            (item): item is HistoryEntry =>
              typeof item === "object" && item !== null && typeof (item as Partial<HistoryEntry>).id === "string",
          )
        : [],
    ),
    Effect.orElseSucceed(() => []),
  )

export type AddResult = { readonly error: string; readonly rule?: undefined } | { readonly rule: Rule; readonly error?: undefined }

// The standing rules a new Society starts with (approach ideas #3, #4, #10, #12, #13, #24).
// Every text stays within MAX_TEXT, so seeding can never trip the length refusal in `add`.
// They are seeded by the operator (`by: "operator"`), so a worker cannot remove them —
// the operator can, like any operator rule. A Society that already has its own rules
// keeps them: seeding only fills an empty society scope, it never rewrites one.
export const DEFAULT_SOCIETY_RULES: ReadonlyArray<string> = [
  "A big decision — a library, architecture, or module boundary — needs an ADR in .orchestra/decisions/adr-NNNN.md before the code that implements it.",
  "Before any pause or stop, write .orchestra/sessions/<id>/handoff.md: where you stopped, what works, what does not, and the next step.",
  "Do the riskiest, least-known part of a task first, not the easiest part; fail fast and cheap, while the rest is still undone.",
  "When a task is verified DONE or FAILED, record the outcome in the knowledge map, so the next assignment uses facts, not claims.",
]

/** Adds every default society rule the scope does not already have. Adding is idempotent: a rule whose text is already present is skipped, never duplicated. */
export const seedDefaults = (kv: KV.Interface, scope: string): Effect.Effect<void, LoadError> =>
  Effect.forEach(DEFAULT_SOCIETY_RULES, (text) =>
    add(kv, scope, { text, by: "operator" }).pipe(Effect.asVoid),
  ).pipe(Effect.asVoid)

export const add = (kv: KV.Interface, scope: string, input: { text: string; by: string }): Effect.Effect<AddResult, LoadError> =>
  Effect.gen(function* () {
    const text = input.text.replace(/\s+/g, " ").trim()
    if (!text) return { error: "A rule needs text." } as const
    // A long rule is refused, not cut off: silent truncation rewrote what the operator or the
    // AI meant, and nobody could tell from the stored text.
    if (text.length > MAX_TEXT)
      return { error: `That rule is ${text.length} characters; the limit is ${MAX_TEXT}. Shorten it — long rules are refused, not cut off.` } as const
    const rules = yield* listStrict(kv, scope)
    if (rules.some((rule) => rule.text.toLowerCase() === text.toLowerCase())) return { error: "That rule already exists." } as const
    if (rules.length >= MAX_PER_SCOPE)
      return { error: `This scope already has ${MAX_PER_SCOPE} rules. Remove or merge one first.` } as const
    const taken = new Set(rules.map((rule) => rule.id))
    let rule: Rule | undefined
    for (let attempt = 0; attempt < 10 && rule === undefined; attempt++) {
      const id = `r${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}${attempt > 0 ? `x${attempt}` : ""}`
      if (!taken.has(id)) rule = { id, text, by: input.by, at: Date.now() }
    }
    if (!rule) return { error: "Could not pick a free rule id; try again." } as const
    yield* kv.set(KEY + scope, [...rules, rule] as unknown as KV.Value)
    yield* recordHistory(kv, scope, { action: "add", id: rule.id, text, by: input.by, at: rule.at })
    return { rule } as const
  })

export const remove = (
  kv: KV.Interface,
  scope: string,
  id: string,
  options?: { readonly operator?: boolean },
) =>
  Effect.gen(function* () {
    const rules = yield* listStrict(kv, scope)
    const target = rules.find((rule) => rule.id === id)
    if (!target) return false
    // A rule the operator wrote is theirs in every scope, not just `global`: a worker that
    // could delete it could also rewrite the operator's standing orders.
    if (target.by === "operator" && !options?.operator)
      return yield* new ProtectedError({
        reason: `Rule ${id} was written by the operator; only the operator can remove it.`,
      })
    const next = rules.filter((rule) => rule.id !== id)
    if (next.length === 0 && !scope.startsWith("project-defaults:") && !scope.startsWith("society-defaults:")) yield* kv.remove(KEY + scope)
    else yield* kv.set(KEY + scope, next as unknown as KV.Value)
    yield* recordHistory(kv, scope, { action: "remove", id, text: target.text, by: target.by, at: Date.now() })
    return true
  })

export interface Scopes {
  /** The Society whose own chat this session is. */
  readonly chatOf?: string
  /** The project this session works for. */
  readonly project?: string
  /** The Societies that project belongs to. */
  readonly societies: ReadonlyArray<string>
  /** The session being asked about, its agent (role) and whether it is its project's Orchestrator (main session). */
  readonly session?: string
  readonly role?: string
  readonly orchestrator?: boolean
  /** Scopes a sandbox session reads from the project it was copied from: read-only — the
      sandbox follows the source's rules, it never writes them. */
  readonly inherited?: {
    readonly projects: ReadonlyArray<string>
    readonly societies: ReadonlyArray<string>
  }
}

// Where a session stands: a Society's chat, or a session of a project (and through it of its Societies).
// A subagent or sandbox session inherits the scopes of the session that opened it: its own
// lookups find nothing, but its parent's project and Societies still bind it.
// A sandbox project also inherits the scopes of the project it was copied from: its own
// project and Societies are empty, so without this it would run on an empty rulebook.
// A lookup that fails is an error, not an empty answer: scopes that could not be determined
// must never read as "no rule applies".
export const scopesOf = (input: {
  readonly sessionID: string
  readonly sessions: Session.Interface
  readonly orchestra: Orchestra.Interface
  readonly federation: Federation.Interface
}): Effect.Effect<Scopes, ScopesError> =>
  Effect.gen(function* () {
    const base = yield* baseScopes(input)
    const own = yield* input.sessions.get(input.sessionID as SessionID).pipe(Effect.option)
    // By the project record, not mainOf: mainOf hides the project while a move is pending (and reconciles on every call),
    // which dropped the Orchestrator's own rules exactly then.
    const orchestrator = base.project !== undefined && (yield* input.orchestra.projects()).some((item) => item.main === input.sessionID)
    return {
      ...base,
      session: input.sessionID,
      ...(Option.isSome(own) && typeof own.value.agent === "string" ? { role: own.value.agent } : {}),
      orchestrator,
    } satisfies Scopes
  }).pipe(
    Effect.catchCause((cause) => {
      if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause)
      const error = failureOf(cause)
      return Effect.fail(new ScopesError({ reason: `scopes could not be determined: ${error === undefined ? Cause.pretty(cause) : String(error)}` }))
    }),
  )

const baseScopes = (input: {
  readonly sessionID: string
  readonly sessions: Session.Interface
  readonly orchestra: Orchestra.Interface
  readonly federation: Federation.Interface
}): Effect.Effect<Scopes, ScopesError> =>
  Effect.gen(function* () {
    const groups = yield* input.federation.groups()
    let current: string | undefined = input.sessionID
    const seen = new Set<string>()
    for (let depth = 0; depth < 8 && current !== undefined && !seen.has(current); depth++) {
      seen.add(current)
      const id = current as SessionID
      const info = yield* input.sessions.get(id).pipe(Effect.option)
      const marker = Option.isSome(info) ? FederationSchema.groupSupervisor(info.value.metadata) : undefined
      if (marker) {
        const chat = groups.find((group) => group.supervisor === id && group.name === marker.groupName)
        if (chat) return { chatOf: chat.name, societies: [chat.name] } satisfies Scopes
      }
      const main = yield* input.orchestra.mainOf(id)
      const owners = main ? {} : yield* input.orchestra.owners()
      const project = main?.id ?? owners[id]
      if (project) {
        const inherited = yield* inheritedScopes(input.orchestra, groups, project, main)
        return {
          project,
          // Every group a project belongs to is one of its Societies, council or lead:
          // a lead group's President and its member projects all read the same society rules.
          societies: groups
            .filter((group) => group.projects.includes(project as never))
            .map((group) => group.name),
          ...(inherited ? { inherited } : {}),
        } satisfies Scopes
      }
      current = Option.isSome(info) ? (info.value.parentID as string | undefined) : undefined
    }
    return { societies: [] } satisfies Scopes
  }).pipe(
    Effect.catchCause((cause) => {
      if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause)
      const error = failureOf(cause)
      return Effect.fail(
        new ScopesError({
          reason: `scopes could not be determined: ${error === undefined ? Cause.pretty(cause) : String(error)}`,
        }),
      )
    }),
  )

// A sandbox project works in a detached worktree of its source, so its sessions inherit the
// source project's rules and Societies instead of starting from an empty rulebook. The chain
// is followed while each step is itself a sandbox; a source that is not a project — a bare
// repository the operator sandboxed directly — inherits nothing. The project list is only
// read when the session's own record does not already rule a sandbox out.
const inheritedScopes = (
  orchestra: Orchestra.Interface,
  groups: ReadonlyArray<FederationSchema.Group>,
  project: string,
  main: Orchestra.Project | undefined,
) =>
  Effect.gen(function* () {
    if (main !== undefined && main.sandbox === undefined) return undefined
    const all = yield* orchestra.projects()
    const projects: Array<string> = []
    const societies: Array<string> = []
    let current = main ?? all.find((item) => item.id === project)
    const seen = new Set<string>()
    while (current?.sandbox !== undefined && !seen.has(current.id)) {
      seen.add(current.id)
      const source = all.find((item) => item.directory === current?.sandbox?.source)
      if (!source) break
      if (!projects.includes(source.id)) projects.push(source.id)
      for (const group of groups.filter((item) => item.projects.includes(source.id as never)))
        if (!societies.includes(group.name)) societies.push(group.name)
      current = source
    }
    if (projects.length === 0) return undefined
    return { projects, societies }
  })

/** Resolve reach before reading or mutating another session's rule scope. */
export const sessionReach = (input: {
  readonly projectID: string
  readonly sessionID: string
  readonly sessions: Pick<Session.Interface, "get">
  readonly orchestra: Pick<Orchestra.Interface, "projects" | "owns">
}): Effect.Effect<string, ScopesError> => Effect.gen(function* () {
  const project = (yield* input.orchestra.projects()).find((item) => item.id === input.projectID)
  const session = yield* input.sessions.get(input.sessionID as SessionID).pipe(Effect.option)
  if (!project || Option.isNone(session) || !(yield* input.orchestra.owns(project, session.value)))
    return yield* new ScopesError({ reason: "The target session is not owned by this project. No rule scope was accessed." })
  return sessionScope(String(session.value.id))
}).pipe(Effect.catchCause((cause) => {
  if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause)
  return Effect.fail(new ScopesError({ reason: "The target session owner could not be verified. No rule scope was accessed." }))
}))

// --- Priority and conflicts -------------------------------------------------
//
// Society > project > global. A rule in a lower scope never overrides a higher one, and a
// contradiction is an error the load reports, not a choice left to the model. Detection is
// deliberately narrow — the same core instruction with opposite polarity — so ordinary
// rules that merely differ never trip it.

const NEGATIVE = ["never", "must not", "mustn't", "do not", "don't", "cannot", "can't", "forbidden", "prohibited", "refuse", "avoid", "no ", "not "]
const POSITIVE = ["always", "must", "do", "should", "required", "ensure"]

const polarityOf = (text: string): "negative" | "positive" | undefined => {
  const lower = ` ${text.toLowerCase().replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim()} `
  if (NEGATIVE.some((word) => lower.includes(` ${word.trim()} `) || lower.startsWith(` ${word.trim()} `))) return "negative"
  if (POSITIVE.some((word) => lower.includes(` ${word} `))) return "positive"
  return undefined
}

const coreOf = (text: string): string => {
  let core = text.toLowerCase().replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim()
  for (const word of [...NEGATIVE, ...POSITIVE].sort((a, b) => b.length - a.length)) {
    const token = word.trim()
    if (core.startsWith(`${token} `)) core = core.slice(token.length + 1)
  }
  return core.replace(/^(you|we|the team|agents?|all) /g, "").trim()
}

/** The first rule in `rules` that contradicts `text`, or undefined when there is none. */
export const findConflict = (text: string, rules: ReadonlyArray<Rule>): Rule | undefined => {
  const polarity = polarityOf(text)
  if (!polarity) return undefined
  const core = coreOf(text)
  if (!core) return undefined
  return rules.find((rule) => polarityOf(rule.text) === (polarity === "negative" ? "positive" : "negative") && coreOf(rule.text) === core)
}

const crossScopeConflict = (
  parts: ReadonlyArray<{ title: string; scope: string; rules: ReadonlyArray<Rule> }>,
): { higher: { title: string; rule: Rule }; lower: { title: string; rule: Rule } } | undefined => {
  for (let higher = 0; higher < parts.length; higher++) {
    for (let lower = higher + 1; lower < parts.length; lower++) {
      for (const rule of parts[lower].rules) {
        const other = findConflict(rule.text, parts[higher].rules)
        if (other)
          return {
            higher: { title: parts[higher].title, rule: other },
            lower: { title: parts[lower].title, rule },
          }
      }
    }
  }
  return undefined
}

// The system-prompt block for a session. A scope that fails to load, or a contradiction
// between scopes, fails the whole block: an agent that starts without its rules is worse
// than one that does not start.
/** The block plus the same rules as data, operator rules first, for the enforcement layers. */
export const load = (kv: KV.Interface, scopes: Scopes) =>
  Effect.gen(function* () {
    if (scopes.project) yield* snapshotDefaults(kv, scopes.project)
    else if (scopes.chatOf) yield* snapshotSocietyDefaults(kv, scopes.chatOf)

    const wanted = [
      { title: "Society", scope: scopes.societies.map(societyScope) },
      { title: "Society (inherited)", scope: (scopes.inherited?.societies ?? []).map(societyScope) },
      { title: "Project", scope: scopes.project ? [projectScope(scopes.project)] : [] },
      { title: "Project (inherited)", scope: (scopes.inherited?.projects ?? []).map(projectScope) },
      { title: "Orchestrator", scope: scopes.orchestrator && scopes.project ? [orchestratorScope(scopes.project)] : [] },
      { title: "Role", scope: scopes.project && scopes.role ? [roleScope(scopes.project, scopes.role)] : [] },
      { title: "Session", scope: scopes.session ? [sessionScope(scopes.session)] : [] },
      { title: "Defaults copy", scope: scopes.project ? [projectDefaultsScope(scopes.project)] : scopes.chatOf ? [societyDefaultsScope(scopes.chatOf)] : [] },
    ]
    const parts = yield* Effect.forEach(wanted, (group) =>
      Effect.forEach(group.scope, (scope) => listStrict(kv, scope)).pipe(
        Effect.map((lists) => ({ title: group.title, scope: group.scope.join(", "), rules: lists.flat() })),
      ),
    )
    const conflict = crossScopeConflict(parts)
    if (conflict)
      return yield* new ConflictError({
        reason:
          `Rule conflict: [${conflict.higher.title}] "${conflict.higher.rule.text}" contradicts ` +
          `[${conflict.lower.title}] "${conflict.lower.rule.text}". Society rules override project rules, which override defaults copies; ` +
          `remove or rewrite one of them — the model does not pick a winner.`,
      })
    const lines = parts.flatMap((part) => part.rules.map((rule) => `- [${part.title}] ${rule.text}`))
    const entries = parts
      .flatMap((part) => part.rules.map((rule) => ({ title: part.title, text: rule.text, by: rule.by })))
      .toSorted((a, b) => Number(b.by === "operator") - Number(a.by === "operator"))
    if (lines.length === 0) return { block: "", entries }
    const block = [
      "# Rules",
      "Standing rules of this crew, set by the operator and by teammates. Society rules override project rules, which override defaults copies; a conflict between scopes is an error, not a judgement call. Follow them in every task. When you learn something the whole crew must follow, add it with the rules tool instead of repeating it in briefs; never add a rule that contradicts the operator.",
      ...lines,
    ].join("\n")
    return { block, entries }
  })

export const block = (kv: KV.Interface, scopes: Scopes) => load(kv, scopes).pipe(Effect.map((loaded) => loaded.block))


/** Shared request-time load used by the context hook, including scheduled turns. */
export const loadCurrent = (kv: KV.Interface, scopes: Scopes, sessionID: string) =>
  Effect.suspend(() => {
    RuleEnforce.loading(sessionID)
    return load(kv, scopes).pipe(Effect.tap((loaded) => Effect.sync(() => RuleEnforce.remember(sessionID, loaded.entries))))
  })
