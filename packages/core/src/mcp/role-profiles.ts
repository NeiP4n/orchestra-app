export * as McpRoleProfiles from "./role-profiles.js"

import { Note } from "@orchestra/schema/note"
import { Orchestra } from "@orchestra/schema/orchestra"

// MCP access profiles for every agent role Orchestra ships, derived — never hand-maintained
// as a second list the operator has to keep in sync.
//
// A team role already declares what it may use in its `tools` list (permission actions plus
// MCP patterns such as `context7_*`); the team editor is where the operator edits that list.
// A profile is the MCP view of the same declaration: the servers behind the `<server>_*`
// patterns, with the servers the role's own rules name as part of its method marked
// `required` and the rest `allowed`. Editing a role's tools therefore edits its profile,
// and a custom role gets a correct profile with no extra setup.
//
// The non-team agents have no `tools` list, so their profiles are stated here from the
// permission rules `plugin/agent.ts` actually gives them (that file owns the agents; this
// module only reads the outcome). Consumers: the MCP catalog plugin below in this package
// (it annotates the installed-tools context with the role's required servers), and the
// orchestrator's MCP allocation, which reads `required`/`allowed` instead of guessing.

export type Access = "required" | "allowed"

export interface Grant {
  readonly server: string
  readonly access: Access
}

export type Kind = "team-role" | "orchestrator" | "supervisor" | "agent"

export interface Profile {
  // Role id for team roles ("developer"), the agent's own name for the rest ("orchestrator").
  readonly id: string
  readonly kind: Kind
  // The agent sessions of this role run (`team-developer`, `orchestrator`, ...).
  readonly agent: string
  // True when nothing narrows the role's MCP access: every installed server is allowed.
  // `servers` then lists only the required ones.
  readonly unrestricted: boolean
  readonly servers: readonly Grant[]
  // Why the profile looks the way it does, in one line, for reports and debugging.
  readonly note: string
}

// Tool prefixes that are not one MCP server: `mcp_*` is the MCP management toolset itself.
// Prefix aliases for one server: the REA server answers to both `rea-anything_*` (its catalog
// id) and the legacy `rea_*` pattern in the tool groups.
const aliases: Readonly<Record<string, string>> = { rea: "rea-anything" }
const notServers: ReadonlySet<string> = new Set(["mcp"])

/** The MCP servers behind a role's tool list, after the shared implied-tool expansion. */
export function serversOf(tools: readonly string[]): readonly string[] {
  const servers = Orchestra.withImplied(tools).flatMap((tool) => {
    if (!tool.endsWith("_*")) return []
    const prefix = tool.slice(0, -2)
    if (notServers.has(prefix)) return []
    return [aliases[prefix] ?? prefix]
  })
  return [...new Set(servers)].toSorted()
}

// A server is required for a role when the role's own rules name it as part of how the role
// works (for example the Deep Researcher's rules send it to context7/deepwiki and REA), not
// merely when its toolkit happens to include the pattern.
function requiredIn(rules: string, server: string) {
  if (rules.includes(`${server}_`) || rules.includes(`${server} `) || rules.includes(`${server}/`)) return true
  return Object.entries(aliases).some(([prefix, target]) => target === server && rules.includes(`${prefix}_`))
}

/** The profile of one team role, built-in, edited or custom: derived from its spec alone. */
export function fromRole(role: Orchestra.RoleSpec & { readonly id: string }): Profile {
  if (role.tools === undefined)
    return {
      id: role.id,
      kind: "team-role",
      agent: String(Orchestra.role(role.id)),
      unrestricted: true,
      servers: [],
      note: "The role declares no tool list, which the role contract defines as every tool.",
    }
  const servers = serversOf(role.tools).map((server) => ({
    server,
    access: (requiredIn(role.rules, server) ? "required" : "allowed") as Access,
  }))
  return {
    id: role.id,
    kind: "team-role",
    agent: String(Orchestra.role(role.id)),
    unrestricted: false,
    servers,
    note: "Derived from the role's tool list; servers its rules name are required, the rest allowed.",
  }
}

const agentProfile = (
  id: string,
  kind: Kind,
  unrestricted: boolean,
  servers: readonly Grant[],
  note: string,
  agent: string = id,
): Profile => ({ id, kind, agent, unrestricted, servers, note })

// The agents that are not team roles, with the MCP access their permission rules in
// `plugin/agent.ts` leave them. Utility agents under a deny-all (title, summary) and the
// note chat (deny-all except note/read/question) reach no MCP server at all; the President
// runs under the group supervisor ruleset, which denies everything but federation/questions.
export const standalone: readonly Profile[] = [
  agentProfile("orchestrator", "orchestrator", true, [], "Unrestricted: it inspects the connected servers and allocates them to roles; its planning and durable team facts live in the native board and notes, so no MCP server is required.", String(Orchestra.agent)),
  agentProfile("president", "supervisor", false, [], "Group supervisor ruleset denies tools; a group chat coordinates, it does not call MCP servers.", String(Orchestra.president)),
  agentProfile("build", "agent", true, [], "The default agent carries no MCP narrowing of its own; configured permissions decide."),
  agentProfile("general", "agent", true, [], "General-purpose subagent with no MCP narrowing of its own; configured permissions decide."),
  agentProfile(
    "explore",
    "agent",
    false,
    serversOf(["webfetch", "websearch"]).map((server) => ({ server, access: "allowed" as Access })),
    "Read-only codebase explorer: deny-all except native search/read and web access, whose implied MCP documentation and fetch servers are the ones listed.",
  ),
  agentProfile("notes", "agent", false, [], "The note chat is deny-all except the note tool, reading and questions.", String(Note.agent)),
  agentProfile("compaction", "agent", false, [], "Hidden utility agent; no tool access is granted for MCP work."),
  agentProfile("title", "agent", false, [], "Hidden utility agent under a deny-all ruleset."),
  agentProfile("summary", "agent", false, [], "Hidden utility agent under a deny-all ruleset."),
]

/** Every default profile: all built-in team roles plus the standalone agents. */
export const all: readonly Profile[] = [...Orchestra.roles.map(fromRole), ...standalone]

/** The default profile of a team role by role id ("developer"), if it is a built-in role. */
export function forRole(id: string) {
  return all.find((profile) => profile.kind === "team-role" && profile.id === id)
}

/**
 * The profile a session's agent runs under. Team roles resolve from the role list passed in
 * (the live one, so edited and custom roles are honoured); anything else falls back to the
 * standalone agents. Unknown agents get no profile: callers treat that as unrestricted
 * legacy behaviour rather than inventing a restriction.
 */
export function forAgent(agent: string, roles: readonly (Orchestra.RoleSpec & { readonly id: string })[] = Orchestra.roles) {
  const role = roles.find((item) => String(Orchestra.role(item.id)) === agent)
  if (role) return fromRole(role)
  return standalone.find((profile) => profile.agent === agent)
}

/** Whether the profile lets the role call this MCP server's tools at all. */
export function allows(profile: Profile, server: string) {
  if (profile.unrestricted) return true
  return profile.servers.some((grant) => grant.server === server)
}

/** The servers the role requires that are not in the given installed set. */
export function missingRequired(profile: Profile, installed: readonly string[]) {
  const present = new Set(installed)
  return profile.servers.filter((grant) => grant.access === "required" && !present.has(grant.server)).map((grant) => grant.server)
}
