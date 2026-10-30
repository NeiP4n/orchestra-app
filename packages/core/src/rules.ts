export * as Rules from "./rules.js"

import { Effect, Option } from "effect"
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

export const GLOBAL = "global"
export const projectScope = (id: string) => `project:${id}`
export const societyScope = (name: string) => `society:${name}`

export const list = (kv: KV.Interface, scope: string): Effect.Effect<ReadonlyArray<Rule>> =>
  kv.get(KEY + scope).pipe(
    Effect.map((value) =>
      Array.isArray(value)
        ? value.flatMap((item): Rule[] => {
            const rule = item as Partial<Rule> | null
            return rule && typeof rule.id === "string" && typeof rule.text === "string"
              ? [{ id: rule.id, text: rule.text, by: String(rule.by ?? "operator"), at: Number(rule.at ?? 0) }]
              : []
          })
        : [],
    ),
  )

export type AddResult = { readonly error: string; readonly rule?: undefined } | { readonly rule: Rule; readonly error?: undefined }

export const add = (kv: KV.Interface, scope: string, input: { text: string; by: string }): Effect.Effect<AddResult> =>
  Effect.gen(function* () {
    const text = input.text.replace(/\s+/g, " ").trim().slice(0, MAX_TEXT)
    if (!text) return { error: "A rule needs text." } as const
    const rules = yield* list(kv, scope)
    if (rules.some((rule) => rule.text.toLowerCase() === text.toLowerCase())) return { error: "That rule already exists." } as const
    if (rules.length >= MAX_PER_SCOPE)
      return { error: `This scope already has ${MAX_PER_SCOPE} rules. Remove or merge one first.` } as const
    const rule: Rule = { id: `r${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`, text, by: input.by, at: Date.now() }
    yield* kv.set(KEY + scope, [...rules, rule] as unknown as KV.Value)
    return { rule } as const
  })

export const remove = (kv: KV.Interface, scope: string, id: string) =>
  Effect.gen(function* () {
    const rules = yield* list(kv, scope)
    const next = rules.filter((rule) => rule.id !== id)
    if (next.length === rules.length) return false
    if (next.length === 0) yield* kv.remove(KEY + scope)
    else yield* kv.set(KEY + scope, next as unknown as KV.Value)
    return true
  })

export interface Scopes {
  /** The Society whose own chat this session is. */
  readonly chatOf?: string
  /** The project this session works for. */
  readonly project?: string
  /** The Societies that project belongs to. */
  readonly societies: ReadonlyArray<string>
}

// Where a session stands: a Society's chat, or a session of a project (and through it of its Societies).
export const scopesOf = (input: {
  readonly sessionID: string
  readonly sessions: Session.Interface
  readonly orchestra: Orchestra.Interface
  readonly federation: Federation.Interface
}) =>
  Effect.gen(function* () {
    const id = input.sessionID as SessionID
    const info = yield* input.sessions.get(id).pipe(Effect.option)
    const marker = Option.isSome(info) ? FederationSchema.groupSupervisor(info.value.metadata) : undefined
    const groups = yield* input.federation.groups()
    if (marker) {
      const chat = groups.find((group) => group.supervisor === id && group.name === marker.groupName)
      if (chat) return { chatOf: chat.name, societies: [chat.name] } satisfies Scopes
    }
    const main = yield* input.orchestra.mainOf(id).pipe(Effect.orElseSucceed(() => undefined))
    const owners = main ? {} : yield* input.orchestra.owners().pipe(Effect.orElseSucceed(() => ({}) as Record<string, string>))
    const project = main?.id ?? owners[id]
    if (!project) return { societies: [] } satisfies Scopes
    return {
      project,
      societies: groups
        .filter((group) => FederationSchema.modeOf(group) === "council" && group.projects.includes(project as never))
        .map((group) => group.name),
    } satisfies Scopes
  })

// The system-prompt block for a session, empty when no rule applies.
export const block = (kv: KV.Interface, scopes: Scopes) =>
  Effect.gen(function* () {
    const parts = yield* Effect.forEach(
      [
        { title: "Society", scope: scopes.societies.map(societyScope) },
        { title: "Project", scope: scopes.project ? [projectScope(scopes.project)] : [] },
        { title: "Global", scope: [GLOBAL] },
      ],
      (group) =>
        Effect.forEach(group.scope, (scope) => list(kv, scope)).pipe(
          Effect.map((lists) => ({ title: group.title, rules: lists.flat() })),
        ),
    )
    const lines = parts.flatMap((part) => part.rules.map((rule) => `- [${part.title}] ${rule.text}`))
    if (lines.length === 0) return ""
    return [
      "# Rules",
      "Standing rules of this crew, set by the operator and by teammates. Follow them in every task. When you learn something the whole crew must follow, add it with the rules tool instead of repeating it in briefs; never add a rule that contradicts the operator.",
      ...lines,
    ].join("\n")
  })
