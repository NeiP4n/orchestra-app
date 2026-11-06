export * as RoleToolkits from "./toolkits.js"

import { Orchestra } from "@orchestra/schema/orchestra"
import { Wildcard } from "../util/wildcard.js"

// Role toolkits (idea "role toolkits", 2026-11-06): every role gets the tools
// its own work needs, and nothing else.
//
// The built-in roles already carry their tool lists in the schema
// (`Orchestra.roles` = baseRoles + the `toolkits` map there), so this module
// does NOT keep a second static map: a role with an explicit list keeps
// exactly that list. What was missing is the roles that have NO list —
// operator-created roles, and the roles a planner invents on a live run
// (Probe Runner in Б14, and the like). Until now those ran unrestricted:
// `plugin/team.ts` pushed no permission rules for them, the sessions tool
// checked per-task tools against no ceiling, and `McpRoleProfiles.fromRole`
// reported them as unrestricted. This module closes that hole with a kind
// default: an unlisted role is classified into one of the seven kinds below
// and inherits the toolkit of the built-in role of that kind. The operator
// can still widen a role in the team editor; the default only stops a role
// from silently running with every tool at once.

/** The seven kinds of work a Society's roles fall into. */
export type RoleKind =
  | "orchestrator"
  | "scout"
  | "architect"
  | "coder"
  | "tester"
  | "reviewer"
  | "releaser"
  | "general"

export const ROLE_KINDS: ReadonlyArray<RoleKind> = [
  "orchestrator",
  "scout",
  "architect",
  "coder",
  "tester",
  "reviewer",
  "releaser",
  "general",
]

/** The built-in role whose toolkit a kind inherits (see `Orchestra.roles`). */
export const KIND_ANCHOR: Record<Exclude<RoleKind, "general">, string> = {
  orchestrator: "strategic-planner",
  scout: "researcher",
  architect: "architect",
  coder: "developer",
  tester: "tester",
  reviewer: "reviewer",
  releaser: "devops",
}

// A conservative floor when the anchor role is missing from the catalog
// (it never is in the shipped catalog; this only guards a broken build).
// Read-only work plus notes and skills: a role can always look and ask.
const FALLBACK_TOOLS: Record<RoleKind, ReadonlyArray<string>> = {
  orchestrator: ["read", "glob", "grep", "symbols", "file-diff", "shell", "hub", "webfetch", "websearch", "research", "skill", "skill_catalog", "note", "idea_bank", "plots", "github_*"],
  scout: ["read", "glob", "grep", "symbols", "file-diff", "shell", "hub", "webfetch", "websearch", "research", "browser", "skill", "skill_catalog", "note", "idea_bank", "plots", "github_*"],
  architect: ["read", "glob", "grep", "symbols", "file-diff", "shell", "hub", "webfetch", "websearch", "research", "skill", "skill_catalog", "note", "idea_bank", "plots", "github_*"],
  coder: ["read", "glob", "grep", "symbols", "file-diff", "edit", "patch", "write", "shell", "hub", "webfetch", "websearch", "research", "skill", "skill_catalog", "note", "idea_bank", "plots", "github_*"],
  tester: ["read", "glob", "grep", "symbols", "file-diff", "shell", "hub", "webfetch", "websearch", "research", "browser", "desktop", "playtest", "skill", "skill_catalog", "note", "idea_bank", "plots", "github_*"],
  reviewer: ["read", "glob", "grep", "symbols", "file-diff", "shell", "hub", "webfetch", "websearch", "research", "browser", "skill", "skill_catalog", "note", "idea_bank", "plots", "github_*"],
  releaser: ["read", "glob", "grep", "symbols", "file-diff", "edit", "patch", "write", "shell", "hub", "webfetch", "websearch", "research", "browser", "skill", "skill_catalog", "note", "idea_bank", "plots", "github_*"],
  general: ["read", "glob", "grep", "symbols", "file-diff", "edit", "patch", "write", "shell", "hub", "webfetch", "websearch", "research", "browser", "desktop", "playtest", "skill", "skill_catalog", "note", "idea_bank", "plots", "github_*"],
}

export interface RoleLike {
  readonly id?: string
  readonly name?: string
  readonly category?: string
  readonly tools?: ReadonlyArray<string>
}

// The id/name/category words that place a role in a kind. Order matters:
// "strategic-planner" must read as orchestrator before "planner" is seen as
// anything else, and "tester" must win over the "quality" category, which
// on its own means reviewer.
const KIND_PATTERNS: ReadonlyArray<{ readonly kind: RoleKind; readonly pattern: RegExp }> = [
  { kind: "orchestrator", pattern: /orchestrat|planner|strategic|coordinat|president|lead/ },
  { kind: "scout", pattern: /scout|research|explor|recon|investigat|analyst/ },
  { kind: "architect", pattern: /architect/ },
  { kind: "tester", pattern: /tester|probe|qa\b|quality.assurance/ },
  { kind: "reviewer", pattern: /review|audit|critic|counterexample/ },
  { kind: "releaser", pattern: /devops|releas|deploy/ },
  { kind: "coder", pattern: /developer|coder|build|engineer|programmer|implement|debugger/ },
]

/** Which of the seven kinds a role is, from its id, name and category. */
export function kindOfRole(role: RoleLike): RoleKind {
  const haystack = [role.id ?? "", role.name ?? "", role.category ?? ""].join(" ").toLowerCase()
  for (const { kind, pattern } of KIND_PATTERNS) {
    if (pattern.test(haystack)) return kind
  }
  if (/planning/i.test(role.category ?? "")) return "orchestrator"
  if (/quality/i.test(role.category ?? "")) return "reviewer"
  return "general"
}

/** The toolkit a kind inherits: the anchor role's list, or the floor above. */
export function toolkitForKind(kind: RoleKind): ReadonlyArray<string> {
  if (kind === "general") return FALLBACK_TOOLS.general
  const anchor = Orchestra.roles.find((role) => role.id === KIND_ANCHOR[kind])
  return anchor?.tools ?? FALLBACK_TOOLS[kind]
}

/**
 * The tools a role may use: its explicit list when the operator set one,
 * otherwise its kind's toolkit. Never undefined, never "everything": a role
 * without a list used to run unrestricted, which is how a planner-invented
 * role (Probe Runner, Б14) could load any tool at all.
 */
export function effectiveTools(role: RoleLike | undefined): ReadonlyArray<string> | undefined {
  if (!role) return undefined
  if (role.tools) return role.tools
  return toolkitForKind(kindOfRole(role))
}

/** Whether `tool` is inside the role's effective toolkit. */
export function toolAllowed(role: RoleLike | undefined, tool: string): boolean {
  const tools = effectiveTools(role)
  if (tools === undefined) return true
  return Orchestra.withImplied(tools).some((pattern) => Wildcard.match(tool, pattern))
}

export interface AuditEntry {
  readonly tool: string
  /** Why the tool is outside the role's toolkit, in one line. */
  readonly reason: string
}

export interface Audit {
  readonly allowed: ReadonlyArray<string>
  readonly outside: ReadonlyArray<AuditEntry>
}

/**
 * Split a requested tool list into what the role's toolkit allows and what
 * sits outside it. Pure, so the sessions tool and the team plugin can both
 * use it: the refusal stays where it already was (per-task narrowing), and
 * the caller logs `outside` as the explicit journal warning the idea asks
 * for whenever a role loads a tool that is not its own.
 */
export function auditTools(role: RoleLike | undefined, requested: ReadonlyArray<string>): Audit {
  const allowed: string[] = []
  const outside: AuditEntry[] = []
  for (const tool of requested) {
    if (tool === "all") {
      outside.push({
        tool,
        reason: "tools \"all\" lifts the role's toolkit ceiling for this task; the role runs unrestricted",
      })
      continue
    }
    if (toolAllowed(role, tool)) {
      allowed.push(tool)
      continue
    }
    const tools = effectiveTools(role)
    outside.push({
      tool,
      reason:
        tools === undefined
          ? "this session has no team role, so no toolkit applies"
          : `outside the ${kindOfRole(role!)} toolkit (${tools.join(", ")})`,
    })
  }
  return { allowed, outside }
}
