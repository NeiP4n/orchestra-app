export * as AutoloopRules from "./rules.js"

// Cycle rules (block B3). Port of agent-autoloop's kernel/rules.ts: the
// shape `decide` reads, and which events a rule takes.
//
// The source of rules is Orchestra config, NOT a separate rules.json: the
// service (a later B3 sub-step) builds a `Rules` value from the Orchestra
// configuration (roles become agents, the cycle config becomes limits) and
// hands it to `decide` as part of the environment. Nothing here reads a
// file, and nothing here reads the database.

export type Access = "read" | "edit" | "full"

export type Source = { name: string; adapter?: string }

type AgentOptions = { model?: string; effort?: string; command?: string[]; timeout?: number }

export type Agent = AgentOptions & { name: string; worker: string; use: string; access: Access }

export type Channel = { name: string; answerers?: string[]; links?: boolean }

export type Tell = "always" | "needed" | "never"

export type EventFilter = { source: string; types: string[] }

export type When = EventFilter | { cron: string }

type RuleOptions = { skill?: string; prompt?: string; parallel?: number; resume?: boolean; emits?: EventFilter }

/**
 * One cycle rule: "when an event of this type arrives from this source, hand
 * it to agent `to`, in folder `cwd`, in group `group`". `tell` says whether
 * the owner hears about a finished run (`always` / `needed` / `never`).
 * Without `parallel` a rule's group runs one at a time; with it, each
 * subject is its own thread, that many at once.
 */
export type Rule = RuleOptions & { name: string; when: When; to: string; cwd: string; group: string; tell: Tell }

/** A scheduled task that runs elsewhere: the cycle neither starts nor records it. */
export type Elsewhere = { name: string; source: string; to: string; cron: string; where: string }

type Registered = { sources: Record<string, Source>; agents: Record<string, Agent>; channels: Record<string, Channel> }

export type Rules = Registered & { timezone: string; askFirst: string[]; rules: Rule[]; elsewhere: Elsewhere[] }

/** The source of what the clock makes happen. */
export const SCHEDULE = "schedule"

function typeMatch(pattern: string, type: string) {
  return pattern === "*" || pattern === type || (pattern.endsWith(".*") && type.startsWith(pattern.slice(0, -1)))
}

export const typeMatches = (patterns: string[], type: string) => patterns.some((pattern) => typeMatch(pattern, type))

export const eventRule = (rule: Rule): rule is Rule & { when: EventFilter } => "source" in rule.when

export const cronOf = (rule: Rule) => (rule.when as { cron: string }).cron

/** An empty rule set: no sources, no agents, no rules — nothing is dispatched. */
export const emptyRules = (timezone = "UTC"): Rules => ({
  sources: {},
  agents: {},
  channels: {},
  timezone,
  askFirst: [],
  rules: [],
  elsewhere: [],
})
