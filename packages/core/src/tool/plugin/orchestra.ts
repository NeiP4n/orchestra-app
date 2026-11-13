import { DesktopIsolation } from "../../desktop-isolation.js"
import { DeliveryRecall } from "../../delivery-recall.js"
import { SessionCompletionGate } from "../../session/completion-gate.js"
import { ReconDedup } from "../../recon-dedup.js"
export * as OrchestraTool from "./orchestra.js"

import { SCOPE_KEY, scopePaths, disjointScopes } from "../../staffing.js"
import { BrowserLifecycle } from "../../browser/lifecycle.js"
import { BrowserProvenance } from "../../browser/provenance.js"
import { ToolFailure } from "@orchestra/ai"
import type { Context } from "@orchestra/plugin/effect/plugin"
import type { SessionHooks } from "@orchestra/plugin/effect/session"
import { Mode } from "@orchestra/schema/mode"
import { Orchestra as SchemaOrchestra } from "@orchestra/schema/orchestra"
import { Permission } from "../../permission.js"
import { Tool } from "@orchestra/schema/tool"
import { Effect, Option, Schema } from "effect"
import { Form } from "../../form.js"
import { McpAcquire } from "../../mcp/acquire.js"
import { McpCatalog } from "../../mcp/catalog.js"
import { McpSurvey } from "../../mcp/survey.js"
import { Mcp } from "../../mcp/index.js"
import { Model } from "../../model.js"
import { Orchestra } from "../../orchestra.js"
import { OrchestraStage } from "../../stage.js"
import { RoleToolkits } from "../../roles/toolkits.js"
import { ModelRouter } from "../../session/model-router.js"
import { AiStandard } from "../../ai-standard.js"
import { Token } from "../../util/token.js"
import { Trigger } from "../../trigger.js"
import { FormDecision } from "../../form-decision.js"
import { Session } from "../../session.js"
import { SessionSchema } from "../../session/schema.js"
import type { SessionMessage } from "../../session/message.js"
import { SocietyForgeTool } from "./society-forge.js"
import { SocietyPlanTool } from "./society-plan.js"

export const name = "sessions"

// The modes the tool advertises come from the schema registry, so adding or removing a builtin
// mode cannot leave the orchestrator's instructions listing a stale set.
export const MODE_IDS = Mode.builtins
  .filter((mode) => String(mode.id) !== "jailbreak")
  .map((mode) => String(mode.id))
  .join(", ")

export const description = [
  "Run this project's AI team: the other sessions of the project, each a separate chat with its own role.",
  "Only the project's main session (the orchestrator) has this tool.",
  'Required action example: {"action":"list"}. To dispatch: {"action":"send","sessionID":"<id from list>","text":"Check the result"}. Never use task text as model.',
  `Modes: ${MODE_IDS}.`,
  "Actions: list shows the team by category; send queues a task for a worker without interrupting it; create starts or reuses a worker session; read shows a session's latest messages; answer replies to a worker's question; set_mode changes how a session works; stop interrupts it; acquire_mcp installs and verifies a catalog MCP server; plan, stages, stage and verify manage workflow stages.",
  "Before creating a worker, inspect the roster and reuse an existing writable session with the needed role. Do not call HTTP endpoints directly or invent /api/orchestra routes for team management. Use this tool.",
  "The full operating rules (delegation gate, MCP assignment and survey, worker model choice, stage evidence) arrive with this session's first call of this tool.",
].join("\n")

/**
 * The full operating rules of the sessions tool. Carried as the tool's guide, so the
 * text reaches the session once — as the answer to its first call of this tool —
 * instead of riding in the advertised schema on every step of the main session.
 */
/**
 * Free OpenCode Zen models by kind of work (price 0 in the models.dev catalog), best first. This is a
 * suggestion for what the operator enables in /models; it is never applied by itself. The Orchestrator
 * chooses worker models only among the models the operator enabled there.
 */
export const FREE_MODEL_TIERS = [
  {
    tier: "strong",
    for: "planning, architecture, review, security and counterexample work",
    models: ["opencode/kimi-k2.5-free", "opencode/glm-5-free"],
  },
  {
    tier: "code",
    for: "implementation, debugging, devops, data, integration, performance and testing",
    models: ["opencode/grok-code", "opencode/kimi-k2.5-free"],
  },
  {
    tier: "research",
    for: "research, long-context reading and idea generation",
    models: ["opencode/longcat-2.5-preview-free", "opencode/nemotron-3-ultra-free"],
  },
  {
    tier: "cheap",
    for: "writing, design, marketing, support, accessibility and other light or routine work",
    models: ["opencode/deepseek-v4-flash-free", "opencode/mimo-v2.6-flash-free", "opencode/ling-3.1-flash-free"],
  },
] as const

/** True when a model is one of the models the operator enabled in /models (provider and id; a variant is not part of the pick). */
export const inEnabled = (enabled: ReadonlyArray<Model.Ref>, model: Model.Ref) =>
  enabled.some((item) => item.providerID === model.providerID && item.id === model.id)

export const freeModelGuide = [
  "Worker models come only from the models the operator switched on in /models (the enabled model collections) and nothing outside them. Leave model out and the enabled models are routed for each task automatically; pass model only to pick one specific enabled model, and match the work: the strongest for planning, review and hard debugging, a cheaper one for routine work. A model that is not enabled is refused with the list of enabled ones. With nothing enabled, workers use the session's model.",
  `The operator's spend limit is 0, so the enabled models should be free ones. A good set to suggest to them: ${FREE_MODEL_TIERS.map((item) => `${item.tier} (${item.for}): ${item.models.join(", ")}`).join("; ")}. Suggest, never assume: you can only use what they enabled.`,
].join("\n")

export const guide = [
  "Run this project's AI team: the other sessions of the project, each a separate chat with its own role.",
  "Only the project's main session (the orchestrator) has this tool.",
  "Inspect the roster, reuse an idle writable worker, or create the needed role yourself. Include workScope in every file task: create automatically adds a same-role worker when existing busy workers have known disjoint scopes. For unknown/overlapping scopes wait, never ask the operator how to staff. newInstance=true remains a deliberate independent-worker choice, not a read-only bypass.",
  "Do not call HTTP endpoints directly or invent /api/orchestra routes for team management. Use this tool. If a team action returns an endpoint or API error, report the actual error instead of creating a replacement session.",
  "Actions: list shows the team by category with each session's role, status, access and whether a task is outstanding;",
  "send queues a task without interrupting the worker's current work; its task-linked <team-report> arrives automatically when it finishes and wakes the Orchestrator again. The current turn ending after send is intentional; it does not mean the project task is complete.",
  "A report's state describes whether the worker run ended; outcome describes task progress. If outcome is partial, incomplete, failed, or stopped, treat the task as still open unless it is explicitly blocked or cancelled. outcome=unknown means the worker did not state its status: judge the report text yourself instead of re-sending the task. Compare the report with the acceptance criteria and send a focused follow-up to that same worker after its previous task is no longer outstanding. Do not mark the overall task complete until evidence satisfies the acceptance criteria; if the work is blocked, state the exact blocker.",
  "Copy the complete sessionID exactly from the roster or action list; never abbreviate or invent one. If a sessions action fails, inspect the exact error and current list/read state, correct the cause, then retry only with changed/corrected arguments. Never repeat an identical failed call.",
  "A worker that asks the human a question during its task blocks until someone answers; that question also arrives here as a <team-question>. Answer it with action answer (sessionID of the worker, answers: one list of chosen option labels or your own text per question, in order) by default, choosing the recommended option when unsure; the society runs autonomously. Tell the operator only for hard limits: spending money, secrets through the masked Vault form (never chat or .env), publishing or other irreversible outside actions.",
  "read returns a session's latest messages; create accepts an exact role ID from the global Orchestra role registry even if no session exists for that role yet, reuses a writable matching session by default or creates one if needed, and can give it a first task; set_mode changes how an existing session works; stop interrupts a running session.",
  `Modes: ${MODE_IDS}. A mode changes how a session works and may make it read-only; it never widens the role's permissions. Pass mode to send or create, or use action set_mode. Use fast for trivial work, planning or research before building, coding for implementation, architecture for parallel-safe design, test to verify, review or debug for checks, and self-improvement for work on the product itself. A planner in coding mode still cannot edit files.`,
  "Never pass a display title as a role ID: use an exact role id from the roles listed with your team.",
  "Access per session is hidden < read < write < full: read allows list and read, write adds send, full adds stop. Sessions you create get full access.",
  "The 12-message rule binds you: after 12 of your own messages in a row without handing a task to a worker, your other tool calls are refused until you delegate with send or create. Building the Society (society_forge found/generate, society_plan apply) is never refused by this rule and resets the count like a delegation, so creating the Society never forces a premature dispatch. The MCP survey (mcp_manager inspect) is never refused either — a dispatch needs a fresh survey, so survey first if you have not, then dispatch with an explicit mcp assignment. The roster in your context shows how many of the 12 you have used.",
  "MCP assignment is mandatory, and it is enforced, not advised: every send or create to a team session must pass mcp — the servers the worker may call for that task, maxCalls in total, perServer caps — and a dispatch without it is refused and sends nothing. When a task needs no MCP, say so explicitly: mcp with servers [] and maxCalls 0. You may only tighten the role's own MCP ceiling, never widen it; a refused limit says what the role allows. The limit is stamped on the worker session and stated at the top of its task brief.",
  "The assignment must come from a survey, and that is enforced too: before the first dispatch in a session, call mcp_manager with action=inspect once — it lists the configured servers (status, discovered tools, leases) and the installable catalog. A dispatch before the survey is refused and sends nothing. Judge the assignment from what the survey shows: no catalog server fitting the task is a finding, and an explicit empty assignment after the survey is the right answer for native-tool work.",
  freeModelGuide,
  "Worker models are a cost decision, so make it deliberately: pass model on create or send — the strongest model for design, hard debugging and review, a mid-tier or small model for mechanical implementation and routine checks. With no explicit model the role's own model or the worker policy applies, and failing those the worker inherits YOUR model, which is the expensive default, not a decision. The dispatch result names the model the worker will run and where it came from.",
  "MCP acquisition: action acquire_mcp makes a catalog MCP server actually usable. Pass server (an exact catalog id) or need (a capability in words, e.g. \"browser automation\") and it selects, installs, connects and verifies the server, reporting its real state and the tools actually discovered — a server counts as ready only when both hold. Pass role to check first that the server sits inside that role's MCP ceiling; outside it, acquisition is refused, not worked around. A needs_auth result names the credential variables the operator must provide; never invent a value. Installing is global and shared by the project, but it grants no role access by itself: role profiles and the per-task mcp limits still decide who may call the server, and removing one role's access never disconnects it for the others.",
  "Workflow stages: for anything beyond a trivial task, record the plan with action plan (stages: each with a name, work categories, role ids, dependsOn stage ids, acceptance criteria and the MCP servers it needs). You decide how many stages the task needs: one for a small fix, many for a system audit. Categories describe kinds of work (Research, Security, Implementation); stages are execution units and one stage may span several categories. Action stages lists the current plan; action stage updates one stage (status, and result as the evidence). Replan by calling plan again when a discovery changes the work: completed stages are preserved exactly as recorded, and a stage may start only when every stage it depends on is completed. Mark a stage completed only with evidence in result — a report, a test run, a commit — never on a worker's claim alone. The overall task is complete only when every stage is completed or explicitly cancelled. The final operator report lists every completed stage 1:1 with its [stage-id], outcome and evidence, and names remaining open/blocked stages. Never claim full completion with open DoD items. Action verify scores a task's own acceptance criteria against real evidence (a pass without evidence does not count, a missing criterion is a gap) — use it as the completion gate instead of trusting a worker's claim.",
].join("\n")

export function withoutDisabledMcpGuidance(text: string, env: NodeJS.ProcessEnv = process.env): string {
  if (env.ORCHESTRA_MCP === "1") return text
  return text.replace(/ A dispatch also needs a fresh MCP survey[^.]*\./g, "")
}
export function dispatchGuide(env: NodeJS.ProcessEnv = process.env): string {
  if (env.ORCHESTRA_MCP === "1") return guide
  return withoutDisabledMcpGuidance(guide.split("\n").filter(line => !line.startsWith("MCP assignment") && !line.startsWith("The assignment must come from a survey"))
    .map(line => line.replace(/ The MCP survey \(mcp_manager inspect\) is never refused either[^.]*\./, ""))
    .join("\n"), env) + "\nMCP is disabled. Do not survey MCP or require an mcp assignment. Use the worker's available native tools."
}

export function desktopDispatchDenial(input: {action:string; text?:string}, platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!["send","create"].includes(input.action) || !input.text || !/(?:desktop[_ -](?:action|check|test|automation)|desktop verification|проверк[аиу]\s+(?:desktop|рабочего стола)|agent-desktop)/i.test(input.text)) return
  const denial = DesktopIsolation.desktopPlatformDenial(env, platform)
  return denial ? `Do not assign desktop verification on this host. ${denial} Use browser verification or non-GUI tests and report native desktop checks as unverified.` : undefined
}

type WorkerRow = {
  role: string
  access: Orchestra.Access
  mode?: string
  session: { id: string; title?: string }
}

export function reusableWorker<T extends WorkerRow>(
  rows: ReadonlyArray<T>,
  role: string,
  pending: ReadonlySet<string>,
) {
  const matches = rows.filter((row) => row.role === role)
  const writable = matches.filter((row) => Orchestra.allows(row.access, "write"))
  return {
    matches,
    writable,
    session: writable.find((row) => !pending.has(row.session.id)),
  }
}

// ---------------------------------------------------------------------------
// The 6-message rule.
//
// The Orchestrator leads the team; it is not a worker. After
// ORCHESTRATOR_MESSAGE_LIMIT of its own messages in a row without handing a
// task to a team session, it must delegate: the gate below refuses its other
// tool calls until a sessions send/create carrying a task goes through.
// Building the Society is exempt: society_forge found/generate and
// society_plan apply are never refused, and one resets the count like a
// delegation — creating the Society must not force a premature dispatch.
// Counting is by assistant message, not by tool call — one message may call
// several tools and still counts once — and only a real delegation resets
// the count: listing or reading the team is management, not distribution,
// and asking the operator a question is neither counted nor blocked (the
// operator may be the only one who can decide). The MCP survey
// (mcp_manager inspect) is exempt too: a dispatch is refused without a
// fresh survey, so blocking the survey at the limit would deadlock the
// Orchestrator — it could neither survey nor dispatch. A new incoming prompt
// (the operator, or a <team-report> waking the Orchestrator) starts a new cycle.
// This complements the older explore-call gate in the team plugin, which
// counts read/grep/glob/shell calls only; this one counts every own message.
export const ORCHESTRATOR_MESSAGE_LIMIT = 12

export interface DelegationGate {
  /** Message IDs of the Orchestrator's own messages counted in this cycle, oldest first. */
  readonly counted: ReadonlyArray<string>
  /** True when this call belongs to a new own message past the limit and must be refused. */
  readonly blocked: boolean
  /** True when this call was a delegation and reset the count. */
  readonly reset: boolean
}

const isDelegationCall = (tool: string, action: string | undefined, text: string | undefined) =>
  tool === name && (action === "send" || action === "create") && !!text?.trim()

// Building the Society hands work to its projects, so it is delegation, not
// the Orchestrator doing the work itself: society_forge found/generate gives
// the goal to the planner and the briefs to the projects, society_plan apply
// sets the whole Society up. The 6-message rule never blocks those calls,
// and one resets the count like a dispatch — otherwise the planner would be
// forced into a premature dispatch halfway through creating the Society.
const isSocietyBuildingCall = (tool: string, action: string | undefined) =>
  (tool === SocietyForgeTool.name && (action === "found" || action === "generate")) ||
  (tool === SocietyPlanTool.name && action === "apply")

const isSocietyTool = (tool: string) => tool === SocietyForgeTool.name || tool === SocietyPlanTool.name

// The MCP survey is a prerequisite for delegating, not the work itself:
// a dispatch is refused without a fresh survey, so refusing the survey
// at the limit would deadlock the Orchestrator — it could neither survey
// nor dispatch. Inspect is read-only (it only lists the fleet), so it is
// always available like team management. Acquiring or installing a server
// stays gated: that mutates the fleet and belongs to setup before the
// limit. The tool name is a literal on purpose: mcp-manager.ts imports
// from this file, so importing its name here would be circular.
const isSurveyCall = (tool: string, action: string | undefined) =>
  tool === "mcp_manager" && action === "inspect"

// Looking at the operator's Browser tab (sessions, info, text, screenshot) is not doing the team's work: it is how the
// Orchestrator answers "what is in my browser", and refusing it made it answer from memory. Acting in the page stays gated.
const isBrowserLook = (tool: string, action: string | undefined) =>
  tool === "browser" && (action === "sessions" || action === "info" || action === "text" || action === "screenshot")

export function delegationGate(
  counted: ReadonlyArray<string>,
  input: { tool: string; messageID: string; action?: string; text?: string },
): DelegationGate {
  if (isDelegationCall(input.tool, input.action, input.text) || isSocietyBuildingCall(input.tool, input.action))
    return { counted: [], blocked: false, reset: true }
  // Team management, Society building, the MCP survey and asking the
  // operator are always available and never count as the Orchestrator
  // doing the work itself.
  if (input.tool === name || input.tool === "question" || input.tool === "dod" || input.tool === "interact" || isSocietyTool(input.tool) || isSurveyCall(input.tool, input.action) || isBrowserLook(input.tool, input.action))
    return { counted, blocked: false, reset: false }
  if (counted.includes(input.messageID)) return { counted, blocked: false, reset: false }
  if (counted.length >= ORCHESTRATOR_MESSAGE_LIMIT) return { counted, blocked: true, reset: false }
  return { counted: [...counted, input.messageID], blocked: false, reset: false }
}

/** Whether a finished assistant message handed a task to a team session or built the Society. */
export function isDelegation(message: SessionMessage.Info): boolean {
  if (message.type !== "assistant") return false
  return message.content.some(
    (part) =>
      part.type === "tool" &&
      part.state.status === "completed" &&
      (isDelegationCall(part.name, part.state.input.action as string | undefined, part.state.input.text as string | undefined) ||
        isSocietyBuildingCall(part.name, part.state.input.action as string | undefined)),
  )
}

/**
 * How many of the Orchestrator's own messages in a row, in chronological
 * order, came after the last delegation or the last incoming message (the
 * operator's, or a synthetic wake-up such as a <team-report>).
 */
export function ownMessageStreak(messages: ReadonlyArray<SessionMessage.Info>): number {
  let streak = 0
  for (const message of messages) {
    if (message.type === "user" || message.type === "synthetic") {
      streak = 0
      continue
    }
    if (message.type !== "assistant") continue
    streak = isDelegation(message) ? 0 : streak + 1
  }
  return streak
}

export function delegationStatus(streak: number) {
  const limit = ORCHESTRATOR_MESSAGE_LIMIT
  const mustDelegate = streak >= limit
  return {
    limit,
    streak,
    remaining: Math.max(0, limit - streak),
    mustDelegate,
    text: mustDelegate
      ? [
          "# 12-message rule — limit reached",
          `You have sent ${streak} of your own messages in a row without handing a task to a team session (limit ${limit}). Your next action MUST be sessions action send or create with the task; your other tool calls are refused until you delegate. Do not keep investigating, editing around it or writing a longer report instead. A dispatch also needs a fresh MCP survey (mcp_manager inspect is always allowed, even at the limit) and an explicit mcp assignment — survey first if you have not, then dispatch. Building the Society (society_forge found/generate, society_plan apply) is always allowed and also resets the count.`,
        ].map(line => withoutDisabledMcpGuidance(line)).join("\n")
      : [
          "# 12-message rule",
          `You have sent ${streak} of your ${limit} own messages in a row since the last task you handed to the team; ${Math.max(0, limit - streak)} remain before you must delegate. After ${limit} own messages you hand tasks to team sessions (sessions send/create) instead of continuing yourself, and other tool calls are refused until you do. Society building (society_forge, society_plan) is never refused by this rule.`,
        ].join("\n"),
  }
}

// ---------------------------------------------------------------------------
// MCP limits per role, distributed by the Orchestrator.
//
// A role's own toolkit is its MCP ceiling: the namespaced tool patterns in
// its tool list (context7_*, playwright_*, ...) name the MCP servers it may
// reach at all, and the call caps below bound how much of them one task may
// burn. The Orchestrator distributes a per-task limit with the sessions
// tool's `mcp` field; resolveMcpLimit guarantees it can only tighten the
// ceiling, never widen it. The effective limit is applied at dispatch time,
// in two layers: servers outside the allowlist are denied for the worker
// session through its permission rules, and the whole limit is stamped on
// the session metadata under MCP_LIMIT_METADATA_KEY (with a fresh
// `budgetEpoch` per hand-out) and stated at the top of the task brief. Every
// dispatch — with or without an explicit limit — also stamps the session's
// MCP assignment record under MCP_ASSIGNMENT_METADATA_KEY, so the sidebar can
// show what each session was actually granted for its current task. The
// MCP runtime reads the stamp back in `MCP.callTool` and counts every call
// against it through the budget gate in mcp/budget.ts — the allowlist, the
// total maxCalls and the perServer caps are all enforced there, atomically,
// before dispatch.

/** Session metadata key carrying the MCP limit the Orchestrator last handed the session. */
export const MCP_LIMIT_METADATA_KEY = "orchestra:mcp-limit"
/** Session metadata key carrying the session's current MCP assignment record. */
export const MCP_ASSIGNMENT_METADATA_KEY = "orchestra:mcp-assignment"
/** Session metadata key stamped on the Orchestrator's session by mcp_manager inspect: proof the fleet was surveyed before dispatching. */
export const MCP_SURVEY_METADATA_KEY = "orchestra:mcp-survey"

/**
 * The explicit MCP assignment the Orchestrator gave one session for its current
 * task. Stamped on the session metadata at every send/create dispatch that has
 * a team role. Since the assignment gate, a dispatch without an `mcp` field is
 * refused, so records are explicit: true — except historical ones stamped
 * before the gate, which inherited the role's ceiling (explicit: false). A
 * missing stamp unambiguously means "no task has been dispatched to this
 * session yet", never "everything is assigned". An empty servers list is an
 * explicit assignment of no MCP. This record is display truth for the
 * sidebar; enforcement stays with the limit stamp (MCP_LIMIT_METADATA_KEY),
 * the deny rules and the budget gate.
 */
export interface McpAssignment {
  /** MCP server names granted to this task, or "all" when the role sets no boundary. */
  readonly servers: ReadonlyArray<string> | "all"
  /** Total MCP tool calls the task's limit allows (the role ceiling when inherited). */
  readonly maxCalls: number
  /** Per-server call caps of the task's limit. */
  readonly perServer: Readonly<Record<string, number>>
  /** True when the Orchestrator passed an explicit `mcp` field for this task. */
  readonly explicit: boolean
  /** The budget epoch of the task's limit stamp, or null when the assignment is inherited. */
  readonly budgetEpoch: string | null
  /** When this assignment was stamped (epoch milliseconds). */
  readonly assignedAt: number
  /** MCP servers this assignment denied with generated permission rules, so the next dispatch can remove exactly those rules instead of letting them pile up on a reused worker. Absent on records stamped before this was tracked. */
  readonly deniedServers?: ReadonlyArray<string>
}

/** Read a session's MCP assignment record out of its metadata; undefined when never assigned. */
export function mcpAssignmentOf(metadata: Record<string, unknown> | undefined): McpAssignment | undefined {
  const raw = metadata?.[MCP_ASSIGNMENT_METADATA_KEY]
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined
  const record = raw as Record<string, unknown>
  const servers =
    record.servers === "all"
      ? "all"
      : Array.isArray(record.servers) && record.servers.every((item) => typeof item === "string")
        ? (record.servers as string[])
        : undefined
  if (servers === undefined) return undefined
  if (typeof record.maxCalls !== "number" || !Number.isInteger(record.maxCalls) || record.maxCalls < 0) return undefined
  if (typeof record.assignedAt !== "number") return undefined
  const perServer: Record<string, number> = {}
  if (record.perServer && typeof record.perServer === "object" && !Array.isArray(record.perServer)) {
    for (const [server, cap] of Object.entries(record.perServer as Record<string, unknown>)) {
      if (typeof cap !== "number" || !Number.isInteger(cap) || cap < 0) return undefined
      perServer[server] = cap
    }
  }
  return {
    servers,
    maxCalls: record.maxCalls,
    perServer,
    explicit: record.explicit === true,
    budgetEpoch: typeof record.budgetEpoch === "string" ? record.budgetEpoch : null,
    assignedAt: record.assignedAt,
    ...(Array.isArray(record.deniedServers) && record.deniedServers.every((item) => typeof item === "string")
      ? { deniedServers: record.deniedServers as string[] }
      : {}),
  }
}
/** Default per-task MCP call cap for a role that may change files. */
export const MCP_CALLS_DEFAULT = 24
/** Default per-task MCP call cap for a read-only role: lookups, not bulk work. */
export const MCP_CALLS_READ_ONLY = 12

export interface McpLimit {
  /** MCP server names the worker may call, or "all" when the role sets no boundary. */
  readonly servers: ReadonlyArray<string> | "all"
  /** Total MCP tool calls allowed for the task. */
  readonly maxCalls: number
  /** Per-server call caps, for servers in the effective allowlist. */
  readonly perServer: Readonly<Record<string, number>>
  /** Estimated MCP output tokens allowed for the task, when set; absent means calls alone cap it. */
  readonly maxTokens?: number
}

/** What the Orchestrator asks for in the sessions tool's `mcp` field. */
export interface McpLimitRequest {
  readonly servers?: ReadonlyArray<string>
  readonly maxCalls?: number
  readonly perServer?: Readonly<Record<string, number>>
  readonly maxTokens?: number
}

type RoleMcpShape = {
  readonly name?: string
  readonly tools?: ReadonlyArray<string>
  readonly readOnly?: boolean
}

/**
 * The MCP servers a role may reach at all, from its tool list: a namespaced
 * pattern (`context7_*`) names its server, and `mcp_*` (or no tool list at
 * all) means the role never drew a boundary, so every server is allowed.
 */
export function mcpServersOf(role: RoleMcpShape): ReadonlyArray<string> | "all" {
  if (!role.tools) return "all"
  const servers = new Set<string>()
  for (const tool of SchemaOrchestra.withImplied(role.tools)) {
    if (tool === "*" || tool === "mcp_*") return "all"
    const match = /^(.+)_\*$/.exec(tool)
    if (match) servers.add(match[1])
  }
  return [...servers].toSorted()
}

/**
 * The acquisition ceiling check: may this role ever use that server? Returns
 * the refusal message when the server sits outside the role's own MCP
 * ceiling, undefined when acquisition for this role is legitimate. Pure, so
 * the guard is testable without a live MCP service: acquiring for a role
 * that cannot use the server is refused, never worked around — and the
 * ceiling itself is only ever read here, never widened.
 */
export function acquireCeiling(role: RoleMcpShape, server: string): string | undefined {
  const ceiling = mcpServersOf(role)
  if (ceiling === "all" || ceiling.includes(server)) return undefined
  return `${role.name ?? "This role"} may not use ${server}: its MCP ceiling is ${ceiling.length > 0 ? ceiling.join(", ") : "no MCP servers"}. Acquiring it would give this role nothing; the operator can widen the role if that is intended.`
}

/** The role's own MCP ceiling: what the Orchestrator may distribute from, and never exceed. */
export function defaultMcpLimit(role: RoleMcpShape): McpLimit {
  const servers = mcpServersOf(role)
  const maxCalls = servers !== "all" && servers.length === 0 ? 0 : role.readOnly ? MCP_CALLS_READ_ONLY : MCP_CALLS_DEFAULT
  return { servers, maxCalls, perServer: {} }
}
export type McpLimitResolution = { readonly ok: true; readonly limit: McpLimit } | { readonly ok: false; readonly message: string }

/**
 * The Orchestrator's per-task MCP limit for a role, checked against the
 * role's ceiling: servers must come from the role's own list, and no cap may
 * exceed the ceiling. Anything the Orchestrator leaves open takes the
 * ceiling's value, so passing a partial limit only tightens what it names.
 */
export function resolveMcpLimit(role: RoleMcpShape, requested?: McpLimitRequest): McpLimitResolution {
  const ceiling = defaultMcpLimit(role)
  const who = role.name ?? "This role"
  const servers =
    requested?.servers === undefined
      ? ceiling.servers
      : [...new Set(requested.servers.map((server) => server.trim()).filter(Boolean))]
  if (ceiling.servers !== "all" && Array.isArray(servers)) {
    const outside = servers.filter((server) => !ceiling.servers.includes(server))
    if (outside.length > 0)
      return {
        ok: false,
        message: `${who} may not use MCP server(s) ${outside.join(", ")}; its servers are ${ceiling.servers.join(", ") || "none"}. The Orchestrator distributes limits inside the role's own ceiling, it does not widen it.`,
      }
  }
  if (Array.isArray(servers) && servers.length === 0 && requested?.maxCalls !== undefined && requested.maxCalls > 0)
    return { ok: false, message: "An empty MCP server list forbids MCP for this task, so maxCalls must be 0 or omitted. Nothing was sent. This limit applies only to MCP server calls, not built-in tools such as browser; their role, mode, permissions and safety checks still apply." }
  const maxCalls = Array.isArray(servers) && servers.length === 0 ? 0 : (requested?.maxCalls ?? ceiling.maxCalls)
  if (!Number.isInteger(maxCalls) || maxCalls < 0)
    return { ok: false, message: `MCP maxCalls must be a whole number of 0 or more, got ${maxCalls}.` }
  if (maxCalls > ceiling.maxCalls)
    return {
      ok: false,
      message: `${who}'s MCP ceiling is ${ceiling.maxCalls} call(s) per task; ${maxCalls} would widen it. The Orchestrator may tighten a role's limit, not raise it.`,
    }
  const perServer = requested?.perServer ?? {}
  for (const [server, cap] of Object.entries(perServer)) {
    if (Array.isArray(servers) && !servers.includes(server))
      return { ok: false, message: `perServer names ${server}, which is not in this task's MCP server list (${servers.join(", ") || "none"}).` }
    if (!Number.isInteger(cap) || cap < 0)
      return { ok: false, message: `The per-server MCP cap for ${server} must be a whole number of 0 or more, got ${cap}.` }
    if (cap > maxCalls)
      return { ok: false, message: `The per-server MCP cap for ${server} (${cap}) exceeds the task's total MCP limit (${maxCalls}).` }
  }
  const maxTokens = requested?.maxTokens
  if (maxTokens !== undefined && (!Number.isInteger(maxTokens) || maxTokens < 0))
    return { ok: false, message: `The MCP maxTokens must be a whole number of 0 or more, got ${maxTokens}.` }
  return { ok: true, limit: { servers, maxCalls, perServer, ...(maxTokens === undefined ? {} : { maxTokens }) } }
}

/**
 * Permission rules denying every known MCP server outside the limit's
 * allowlist. Rules are evaluated last-match-wins, so these close the servers
 * they name without touching anything else. A server nobody knows about
 * cannot be named here; the numeric caps and any server discovered later are
 * the MCP runtime's side of the limit, read from the session metadata stamp.
 * Each dispatch replaces the previous assignment's generated rules with a
 * fresh set (see `withoutMcpDenyRules`): appending here would let the denies
 * of every past task pile up on a reused worker forever.
 */
export function mcpDenyRules(limit: McpLimit, knownServers: ReadonlyArray<string>): Permission.Ruleset {
  if (limit.servers === "all") return []
  const allowed = new Set(limit.servers)
  return denyRulesForServers([...new Set(knownServers)].filter((server) => !allowed.has(server)))
}

/** The deny rules for exactly these servers, in a stable order. */
export function denyRulesForServers(servers: ReadonlyArray<string>): Permission.Ruleset {
  return [...new Set(servers)]
    .toSorted()
    .map((server) => ({ action: `${server}_*`, resource: "*", effect: "deny" as const }))
}

/**
 * A ruleset with exactly the generated deny rules removed: the ones a
 * previous MCP assignment put there, identified by value. Anything the
 * operator set by hand — or a rule for a server the previous assignment
 * never denied — stays, so a reused worker's next task starts from the
 * operator's rules plus the new assignment, not from every task it ever ran.
 */
export function withoutMcpDenyRules(
  permissions: Permission.Ruleset,
  generated: Permission.Ruleset,
): Permission.Ruleset {
  if (generated.length === 0) return permissions
  const doomed = new Set(generated.map((rule) => `${rule.action}\n${rule.resource}\n${rule.effect}`))
  return permissions.filter((rule) => !doomed.has(`${rule.action}\n${rule.resource}\n${rule.effect}`))
}

/** The one line at the top of a worker's task brief stating the MCP limit it was handed. */
export function mcpBriefLine(limit: McpLimit): string {
  if (process.env.ORCHESTRA_MCP !== "1") return ""
  const servers =
    limit.servers === "all" ? "any connected MCP server" : limit.servers.length > 0 ? limit.servers.join(", ") : "none"
  const per = Object.entries(limit.perServer)
    .map(([server, cap]) => `${server} at most ${cap}`)
    .join(", ")
  const tokens = limit.maxTokens === undefined ? "" : `; at most ${limit.maxTokens} estimated MCP output tokens`
  return `[MCP limit for this task, set by the Orchestrator: at most ${limit.maxCalls} MCP tool call(s) in total; servers allowed: ${servers}${per ? `; per server: ${per}` : ""}${tokens}. This limit applies only to MCP server calls. Built-in tools including browser are unaffected by this MCP budget; their role, mode, permissions and safety checks still apply. Use the assigned built-in tools for native-tool work. If an actual required MCP call is blocked, report that specific call instead of treating this as a limit on all tools.]`
}

const StageInput = Schema.Struct({
  id: Schema.optionalKey(Schema.String).annotate({
    description: "Stable stage id, referenced by other stages' dependsOn. Omit to have one generated.",
  }),
  name: Schema.String,
  description: Schema.optionalKey(Schema.String),
  categories: Schema.optionalKey(Schema.Array(Schema.String)).annotate({
    description: "Work categories this stage covers, e.g. Research, Security, Implementation",
  }),
  roles: Schema.optionalKey(Schema.Array(Schema.String)).annotate({ description: "Role ids assigned to this stage" }),
  sessionIDs: Schema.optionalKey(Schema.Array(Schema.String)).annotate({
    description: "Worker session ids doing this stage's work",
  }),
  dependsOn: Schema.optionalKey(Schema.Array(Schema.String)).annotate({
    description: "Stage ids that must be completed before this stage may run",
  }),
  mcp: Schema.optionalKey(Schema.Array(Schema.String)).annotate({
    description: "MCP servers this stage requires; per-task budgets still go through the mcp field of send/create",
  }),
  acceptance: Schema.optionalKey(Schema.String).annotate({
    description: "Acceptance criteria: what evidence completes this stage",
  }),
})

export const Input = Schema.Struct({
  action: Schema.Literals(["list", "read", "send", "create", "set_mode", "set_model", "stop", "answer", "plan", "stages", "stage", "verify", "acquire_mcp"]),
  sessionID: Schema.optionalKey(SessionSchema.ID).annotate({ description: "Target session for read, send and stop" }),
  text: Schema.optionalKey(Schema.String).annotate({
    description: "Message for send, or the first task for create",
  }),
  title: Schema.optionalKey(Schema.String).annotate({ description: "Title of the session to create" }),
  role: Schema.optionalKey(Schema.String).annotate({
    description: "Exact ID of a built-in or saved Orchestra role, required for create; not the display title. The available role ids are listed with your team.",
  }),
  category: Schema.optionalKey(Schema.String).annotate({
    description: "Category of the session to create, e.g. Planning, Build or Quality",
  }),
  workScope: Schema.optionalKey(Schema.Array(Schema.String)).annotate({description:"For send/create: disjoint project-relative owned file/directory scopes. Reuse idle workers; when all same-role workers are busy with known non-overlapping scopes, create automatically staffs another. Planning metadata, not filesystem permission. Unknown or overlapping scope waits; never invent scope to evade read-only access."}),
  newInstance: Schema.optionalKey(Schema.Boolean).annotate({
    description:
      "Normally omit this: create reuses an existing writable session with this role. Set true only when a separate parallel worker is deliberately needed.",
  }),
  answers: Schema.optionalKey(Schema.Array(Schema.Array(Schema.String))).annotate({
    description:
      "For answer: one entry per question of the worker's <team-question>, in order; each entry lists the chosen option labels, or your own text as a single item",
  }),
  reason: Schema.optionalKey(Schema.String).annotate({
    description:
      "For answer: one short sentence on why you chose this answer. The operator sees it beside the answer, so they can tell an AI decision from their own and judge it.",
  }),
  limit: Schema.optionalKey(Schema.Int).annotate({ description: "How many recent messages read returns (default 10)" }),
  model: Schema.optionalKey(Schema.String).annotate({
    description:
      "For send and create: the provider/model the worker runs this task on, optionally with a reasoning variant (provider/model#high). Without it a new worker runs on your own model; pass it whenever the operator asks for another model. A role with a model list accepts only models from that list; a role the operator pinned to one model cannot be changed.",
  }),
  tools: Schema.optionalKey(Schema.Array(Schema.String)).annotate({
    description:
      'For send and create: narrow the worker to these tools for this task (e.g. ["read", "grep", "glob"] for a pure investigation). Only for roles that allow it; ["all"] restores the role\'s full set.',
  }),
  mode: Schema.optionalKey(Schema.String).annotate({
    description:
      "For send, create and set_mode: a work mode id (auto, fast, coding, research, planning, review, debug, design, ops). A mode changes how the worker works and may make it read-only; it never widens the role's permissions. Use auto to clear the override.",
  }),
  mcp: Schema.optionalKey(
    Schema.Struct({
      servers: Schema.optionalKey(Schema.Array(Schema.String)).annotate({
        description: "MCP server names the worker may call for this task; a subset of the role's own servers. An empty list forbids only MCP server calls, not built-in tools such as browser.",
      }),
      maxCalls: Schema.optionalKey(Schema.Int).annotate({
        description: "Total MCP tool calls the worker may make for this task; at most the role's own ceiling.",
      }),
      maxTokens: Schema.optionalKey(Schema.Int).annotate({
        description:
          "Estimated MCP output tokens the worker may receive for this task; the budget gate refuses further calls once it is spent. Omit for a calls-only budget.",
      }),
      perServer: Schema.optionalKey(Schema.Record(Schema.String, Schema.Int)).annotate({
        description: "MCP call caps per server name, for servers in the effective allowlist.",
      }),
    }),
  ).annotate({
    description:
      "For send and create: REQUIRED when the target session has a team role — the MCP budget you distribute to this worker for this task. It can only tighten the role's own MCP ceiling (shown with the role in your context), never widen it. A dispatch without it is refused; when the task needs no MCP, pass { servers: [], maxCalls: 0 }.",
  }),
  stages: Schema.optionalKey(Schema.Array(StageInput)).annotate({
    description:
      "For plan: the full workflow plan as stage definitions. Replaces the open part of the current plan; completed stages are preserved exactly as recorded.",
  }),
  stage: Schema.optionalKey(Schema.String).annotate({ description: "For stage: the id of the stage to update" }),
  status: Schema.optionalKey(OrchestraStage.Status).annotate({
    description:
      "For stage: the new stage status. A stage may run only when all its dependencies are completed; completed requires result evidence.",
  }),
  result: Schema.optionalKey(Schema.String).annotate({
    description: "For stage: the evidence for the new status — a report, test run or commit for completed; the blocker for blocked or failed",
  }),
  criteria: Schema.optionalKey(Schema.Array(Schema.String)).annotate({
    description:
      "For verify: the acceptance criteria to score — the task's own criteria, one per item. There is no fixed universal checklist; the criteria come from the task or the stage plan.",
  }),
  items: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        criterion: Schema.String,
        status: Schema.Literals(["pass", "fail"]),
        evidence: Schema.String,
      }),
    ),
  ).annotate({
    description:
      "For verify: one item per criterion with its status and the real evidence (test run, build output, review). A pass without evidence does not count.",
  }),
  server: Schema.optionalKey(Schema.String).annotate({
    description: "For acquire_mcp: the exact MCP catalog id to make usable, e.g. playwright, context7, github",
  }),
  need: Schema.optionalKey(Schema.String).annotate({
    description: "For acquire_mcp: the capability needed, in words; the best-matching catalog server is selected and acquired",
  }),
})

export const Output = Schema.Struct({
  output: Schema.String,
  sessionID: Schema.optionalKey(SessionSchema.ID),
})

/**
 * A delegated task runs an explicit reasoning level, never the provider's silent default: a model
 * that offers variants must be named with one, as `provider/model#variant` or through the role's
 * own variant, and an unknown one is refused with the list to choose from. When neither names
 * one, the catalog default is filled in instead of refusing — a planner that passes a bare
 * `provider/model` (Б14: sonnet-5.5 with no variant, guessed wrong and got a tool error) gets
 * the middle reasoning level rather than a dead end. The dispatch result names the model the
 * worker will run, variant included, so the applied default is visible, never silent.
 */
export const DEFAULT_VARIANT = "medium"

/** The variant a bare `provider/model` gets: the middle level when offered, else the first. */
export function defaultVariant(variants: ReadonlyArray<string>): string | undefined {
  if (variants.includes(DEFAULT_VARIANT)) return DEFAULT_VARIANT
  return variants[0]
}

export const resolveVariant = Effect.fnUntraced(function* (
  ref: Model.Ref,
  role: Orchestra.Role | undefined,
  available: ReadonlyArray<{ readonly providerID: string; readonly id: string; readonly variants: ReadonlyArray<{ readonly id: string }> }>,
) {
  const chosen: string | undefined = ref.variant ?? role?.variant
  const withVariant = (variant: string | undefined) =>
    variant === undefined || ref.variant === variant
      ? ref
      : Model.Ref.make({ ...ref, variant: Model.VariantID.make(variant) })
  const known = available.find((item) => item.providerID === ref.providerID && item.id === ref.id)
  // A model without variants runs exactly as before, with or without a role variant.
  if (!known || known.variants.length === 0) return ref
  const names = known.variants.map((variant) => variant.id as string)
  if (chosen === undefined) return withVariant(defaultVariant(names))
  if (!names.includes(chosen)) {
    const suggestion = defaultVariant(names)
    return yield* new ToolFailure({
      message: `Variant "${chosen}" is not available for "${ref.providerID}/${ref.id}". Available: ${names.join(", ")}${suggestion ? `. Did you mean #${suggestion}?` : ""}`,
    })
  }
  return withVariant(chosen)
})

/** A task that drives a web page (open, click, fill, sign in) belongs to the BrowserAgent, not to another role. */
export const BROWSER_TASK =
  /(?:\b(?:open|visit|go to|navigate|click|fill(?: in| out)?|sign ?up|register|log ?in|sign in|scroll)\b|открой|зайди|перейди|кликни|нажми|заполни|зарегистр|войди|залогин)[^\n]{0,80}(?:https?:\/\/|www\.|\.(?:com|org|net|io|ru|ai)\b|\b(?:site|website|web ?page|page|form|button|browser)\b|сайт|страниц|форм|кнопк|браузер)/i
export const BROWSER_ROUTE_REFUSAL = "Page work (open, click, fill, sign in on a site) goes to the BrowserAgent of the browser session: use browser action=sessions to see its chat id, then sessions send there. Send this to another role only for work that is not driving a page."
export const browserRouteRefusal = (roleID: string | undefined, text: string | undefined) =>
  roleID !== "browser-agent" && text !== undefined && BROWSER_TASK.test(text.replaceAll(BROWSER_ROUTE_REFUSAL, ""))
    ? BROWSER_ROUTE_REFUSAL
    : undefined

/**
 * The title of a browser session made by the Orchestrator: the one it gave, unless that is empty or a bare
 * "Browser" / "Browser 2"; then a short one from the task, so the tree never lists "Browser 3".
 */
export const browserSessionTitle = (title: string | undefined, text: string | undefined) => {
  const given = title?.trim() ?? ""
  if (given && !/^browser(?:\s*\d+)?$/i.test(given)) return given
  const words = (text ?? "")
    .split(/\r?\n/, 1)[0]!
    .replace(/https?:\/\/(?:www\.)?/gi, "")
    .replace(/[^\p{L}\p{N}\s.-]+/gu, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 5)
  const short = words.join(" ").slice(0, 32).trim()
  return short ? short[0]!.toUpperCase() + short.slice(1) : "Browser task"
}

const modelRef = (model: Model.Ref) => `${model.providerID}/${model.id}`
const refWithVariant = (model: Model.Ref) => `${modelRef(model)}${model.variant ? `#${model.variant}` : ""}`
const baseOf = (reference: string) => reference.split("#")[0]

export interface RoutedWorkerModel {
  readonly model: string
  readonly variant?: string
}

// The Smart Token Router applied to a worker: classify the task, then buy the cheapest candidate
// that can run the tier's reasoning variant. Pure, because the tool reads the policy, the Feature
// picks and the catalog before calling it; a pinned role, empty text and an empty catalog all
// return undefined, which keeps whatever model the caller already had.
export function routeWorkerModel(input: {
  readonly role: Orchestra.Role
  readonly text: string
  readonly mode?: string
  readonly candidates: ReadonlyArray<Model.Ref>
  readonly catalog: ReadonlyArray<ModelRouter.CatalogModel>
}): RoutedWorkerModel | undefined {
  if (!input.text.trim() || input.catalog.length === 0 || input.candidates.length === 0) return undefined
  // A role the operator pinned to one model has nothing to route between.
  if (input.role.model && !input.role.models?.length) return undefined
  // A role's own model list names the exact reasoning levels allowed there, so its variants stay;
  // without such a list the tier chooses the variant, so candidates carry none.
  const candidates = [
    ...new Set(input.candidates.map((ref) => (input.role.models?.length ? refWithVariant(ref) : modelRef(ref)))),
  ]
  const decision = ModelRouter.classify({
    task: input.text,
    // The display name stays out: it is prose, and "Auditor" would count as an audit keyword for
    // every role that happens to be called that.
    role: `${input.role.id} ${input.role.category}`,
    ...(input.mode ? { mode: input.mode } : {}),
  })
  const routed = ModelRouter.route({
    tier: decision.tier,
    candidates,
    catalog: input.catalog,
    tokens: Token.estimate(input.text),
  })
  return { model: routed.model, ...(routed.variant ? { variant: routed.variant } : {}) }
}

export interface RoutedWorkerModelChoice extends RoutedWorkerModel {
  /** Where the routed model came from: the operator's favorites, a reported fallback, or the open pool. */
  readonly source: "favorite" | "fallback" | "routed"
  /** Why a fallback took the task over the favorites; set only when source is "fallback". */
  readonly reason?: string
}

// Feature picks outrank the role and policy fallbacks, so the router runs over the usable
// favorites FIRST: a cheaper fallback never beats a healthy favorite. Fallbacks are routed only
// when no favorite is left in the candidates (every one refused or on a cooling-down provider —
// workerModels already filtered those) or none can run the task's reasoning variant, and the
// choice says why the favorites lost, so a new provider is never billed silently. An explicit
// task model is honored before this runs, and routeWorkerModel returns undefined for a role
// pinned to one model, so a pin is never rerouted here either.
export function routeWorkerModelWithFavorites(input: {
  readonly role: Orchestra.Role
  readonly text: string
  readonly mode?: string
  readonly candidates: ReadonlyArray<Model.Ref>
  readonly favorites: ReadonlyArray<Model.Ref>
  readonly catalog: ReadonlyArray<ModelRouter.CatalogModel>
  /** Providers in a recorded cooldown; names the cause when a favorite is missing for it. */
  readonly downProviders?: ReadonlyArray<string>
}): RoutedWorkerModelChoice | undefined {
  const route = (candidates: ReadonlyArray<Model.Ref>) =>
    routeWorkerModel({
      role: input.role,
      text: input.text,
      ...(input.mode ? { mode: input.mode } : {}),
      candidates,
      catalog: input.catalog,
    })
  if (input.favorites.length === 0) {
    const routed = route(input.candidates)
    return routed === undefined ? undefined : { ...routed, source: "routed" }
  }
  const favoriteKeys = new Set(input.favorites.map(modelRef))
  const favorites = input.candidates.filter((ref) => favoriteKeys.has(modelRef(ref)))
  const fallbacks = input.candidates.filter((ref) => !favoriteKeys.has(modelRef(ref)))
  if (favorites.length === 0) {
    // Name the cause where it is known and say so where it is not: workerModels drops favorites
    // on a cooling-down provider, and its refusal/dead-model filters and the role's model list
    // drop the rest without saying which.
    const down = new Set(input.downProviders ?? [])
    const cooled = input.favorites.filter((ref) => down.has(ref.providerID))
    const reason =
      cooled.length > 0 && cooled.length === input.favorites.length
        ? `favorite ${cooled.map(modelRef).join(", ")} is on a cooling-down provider`
        : cooled.length > 0
          ? `favorite ${cooled.map(modelRef).join(", ")} is on a cooling-down provider; the rest were filtered out (refused, unavailable, or outside the role's model list)`
          : "no favorite is usable here (refused, unavailable, or outside the role's model list)"
    const routed = route(fallbacks)
    return routed === undefined ? undefined : { ...routed, source: "fallback", reason }
  }
  const favorite = route(favorites)
  if (favorite === undefined) return undefined
  // A variant on the result means the favorite can run the tier's reasoning level.
  if (favorite.variant !== undefined) return { ...favorite, source: "favorite" }
  // The routed favorite carries no tier variant, but ModelRouter skips candidates without a
  // price, so a favorite that CAN run the tier may simply be unpriced. Build the
  // capability-eligible favorite pool over every usable favorite, independent of price, then
  // rank it: the cheapest priced eligible favorite wins, and an eligible unpriced one still
  // beats leaving the task on a favorite that cannot reason at the tier.
  const decision = ModelRouter.classify({
    task: input.text,
    role: `${input.role.id} ${input.role.category}`,
    ...(input.mode ? { mode: input.mode } : {}),
  })
  const wanted = ModelRouter.tierVariants(decision.tier)
  const entryOf = (ref: Model.Ref) =>
    input.catalog.find((item) => item.providerID === ref.providerID && item.id === ref.id)
  const variantOf = (ref: Model.Ref) => {
    if (ref.variant !== undefined) return wanted.includes(ref.variant) ? ref.variant : undefined
    const entry = entryOf(ref)
    return entry?.variants?.find((variant) => wanted.includes(variant.id))?.id
  }
  const eligible = favorites.filter((ref) => variantOf(ref) !== undefined)
  if (eligible.length > 0) {
    const tokens = Token.estimate(input.text)
    const priced = eligible.flatMap((ref) => {
      const value = ModelRouter.price(entryOf(ref)?.cost, tokens)
      return value === undefined ? [] : [{ ref, price: value }]
    })
    const chosen = priced.toSorted((left, right) => left.price - right.price)[0]?.ref ?? eligible[0]
    const variant = variantOf(chosen)
    return { model: modelRef(chosen), ...(variant ? { variant } : {}), source: "favorite" }
  }
  const fallback = fallbacks.length > 0 ? route(fallbacks) : undefined
  if (fallback !== undefined && fallback.variant !== undefined)
    return {
      ...fallback,
      source: "fallback",
      reason: `no favorite offers this task's reasoning variant; fell back to ${fallback.model}#${fallback.variant}`,
    }
  return { ...favorite, source: "favorite" }
}

export const Plugin = {
  id: "orchestra.tool.orchestra",
  effect: Effect.fn("OrchestraTool.Plugin")(function* (ctx: Context) {
    const sessions = yield* Session.Service
    const orchestra = yield* Orchestra.Service
    const forms = yield* Form.Service
    const catalog = yield* Effect.serviceOption(Model.Service)
    const mcp = yield* Effect.serviceOption(Mcp.Service)

    // A role the operator gave a model list keeps to that list and a pinned model is never overridden;
    // any other role may run on any model the catalog has, so the Orchestrator can honour a request for
    // a model other than its own.
    const requireModel = Effect.fnUntraced(function* (role: Orchestra.Role | undefined, model: string) {
      if (!role)
        return yield* new ToolFailure({ message: "This session has no team role, so it keeps its own model; omit model" })
      if (role.models?.length && !role.models.includes(model))
        return yield* new ToolFailure({ message: `${model} is not one of ${role.name}'s models: ${role.models.join(", ")}` })
      if (!role.models?.length && role.model)
        return yield* new ToolFailure({
          message: `${role.name} is pinned to ${role.model} by the operator; omit model`,
        })
      const ref = yield* Effect.try({
        try: () => Model.Ref.parse(model),
        catch: () => new ToolFailure({ message: `Invalid model "${model}". Use provider/model or provider/model#variant, or omit model to keep the worker default. Example: { action: "send", sessionID: "<id from list>", text: "Check the result" }. 'check' is task text or mode=review, not a model.` }),
      })
      // The models the operator enabled in /models are the pool the Orchestrator chooses from; a role's own
      // model list is separate. Nothing enabled means the session's model: there is nothing to choose.
      if (!role.models?.length) {
        const enabled = yield* Orchestra.workerEnabledModels
        if (!inEnabled(enabled, ref))
          return yield* new ToolFailure({
            message:
              enabled.length === 0
                ? `${model} is not enabled: no models are switched on in /models, so workers use the session's model. Omit model.`
                : `${model} is not enabled in /models. Enabled: ${enabled.map(modelRef).join(", ")}. Choose one of them, or omit model.`,
          })
      }
      const withRoleVariant =
        ref.variant === undefined && role.variant !== undefined
          ? Model.Ref.make({ ...ref, variant: Model.VariantID.make(role.variant) })
          : ref
      if (Option.isNone(catalog)) return withRoleVariant
      const available = yield* catalog.value.available()
      const known = available.find((item) => item.providerID === ref.providerID && item.id === ref.id)
      if (role.models?.length || !known) {
        if (role.models?.length || available.length === 0) return withRoleVariant
        return yield* new ToolFailure({
          message: `Model ${ref.providerID}/${ref.id} is not available. Some that are: ${available
            .slice(0, 20)
            .map((item) => `${item.providerID}/${item.id}`)
            .join(", ")}`,
        })
      }
      return yield* resolveVariant(ref, role, available)
    })

    // The Smart Token Router decides a model for a task the operator left open: it reads the task,
    // the role and the mode, picks a tier, and buys the cheapest model that can run that tier's
    // reasoning variant. An explicit model, a role pinned to one model and a missing catalog all
    // keep the previous behaviour instead of guessing.
    const routeModel = Effect.fnUntraced(function* (
      role: Orchestra.Role | undefined,
      text: string | undefined,
      mode: Mode.Spec | undefined,
    ) {
      if (!role || !text?.trim() || Option.isNone(catalog)) return undefined

      const policy = yield* Orchestra.workerPolicy
      const favorites = yield* Orchestra.workerFavorites
      const available = yield* catalog.value.available()
      // The candidates are the operator's own: Feature picks, the role's choice, the worker policy.
      const worker = Orchestra.workerModels(policy, role, { favorites, catalog: available })
      const refs = [worker.model, ...(worker.models ?? [])].filter((item): item is Model.Ref => item !== undefined)
      // Automatic routing stays inside the models the operator enabled in /models, once any are enabled.
      const enabled = yield* Orchestra.workerEnabledModels
      const allowed = (ref: Model.Ref) =>
        (role.models?.length ? role.models.some((item) => baseOf(item) === modelRef(ref)) : true) &&
        (enabled.length === 0 || inEnabled(enabled, ref))
      // Favorites route first: workerModels ranks them ahead of the role/policy fallbacks, but
      // the router alone would let a cheaper fallback beat a healthy favorite. The fallback pool
      // is what workerModels built — the role and policy models plus its society fallback,
      // which workerModels itself resolves from the catalog; the router never scans the raw
      // catalog beyond that pool.
      const routed = routeWorkerModelWithFavorites({
        role,
        text,
        ...(mode ? { mode: mode.id } : {}),
        candidates: refs.filter(allowed),
        favorites,
        catalog: available,
        downProviders: AiStandard.downProviders(available),
      })
      if (!routed) return undefined
      const known = available.find((item) => `${item.providerID}/${item.id}` === routed.model)
      if (!known) return undefined
      // The routed variant is the tier's; a role variant still applies when the tier named none.
      const variant =
        routed.variant ?? (role.variant && known.variants.some((item) => item.id === role.variant) ? role.variant : undefined)
      return {
        ref: Model.Ref.make({
          providerID: known.providerID,
          id: known.id,
          ...(variant ? { variant: Model.VariantID.make(variant) } : {}),
        }),
        source:
          routed.source === "favorite"
            ? "your Feature favorites, routed for the task"
            : routed.source === "fallback"
              ? (routed.reason ?? "fell back from your favorites")
              : "the role/worker policy, routed for the task",
      }
    })

    // Every action runs on behalf of the project's main session and only
    // reaches sessions of the same project at the level the operator granted.
    const target = Effect.fnUntraced(function* (
      project: Orchestra.Project,
      sessionID: SessionSchema.ID | undefined,
      required: Orchestra.Access,
    ) {
      if (!sessionID) return yield* new ToolFailure({ message: "Pass the sessionID of the target session" })
      if (BrowserLifecycle.retired(String(sessionID))) return yield* new ToolFailure({ message: `Сессия браузера ${sessionID} закрыта или удалена оператором. Задача не отправлена. Обновите sessions list; не восстанавливайте её автоматически.` })
      const session = yield* sessions
        .get(sessionID)
        .pipe(Effect.mapError(() => new ToolFailure({ message: `Сессия не существует или недоступна: ${sessionID}. Обновите sessions list; не повторяйте отправку по старому ID.` })))
      const access = yield* orchestra.access(session.id)
      if (session.id === project.main || access === "hidden" || !(yield* orchestra.owns(project, session)))
        return yield* new ToolFailure({ message: `Сессия не существует или недоступна: ${sessionID}. Обновите sessions list; не повторяйте отправку по старому ID.` })
      if (!Orchestra.allows(access, required)) {
        // A BrowserAgent session belongs to the Orchestrator: it raises the level itself instead of asking.
        if (/^team-browser/.test(session.agent ?? "")) {
          yield* orchestra.setAccess(session.id, required === "full" ? "full" : "write")
          return session
        }
        return yield* new ToolFailure({
          message: `Access to ${sessionID} is "${access}"; this action needs "${required}". Send the work to a session you can write to (sessions list shows access), or tell the operator which session needs more access and why.`,
        })
      }
      return session
    })

    // The team as the orchestrator may see it, grouped by category in first-seen order.
    // A session's role is named by its role id, the one action create takes, not its agent id.
    const team = Effect.fnUntraced(function* (project: Orchestra.Project) {
      // A failed session list is a tool failure the model can react to,
      // not a defect that kills the step: orDie hid the cause entirely.
      const members = yield* orchestra.sessions(project.id).pipe(
        Effect.mapError((error) => new ToolFailure({ message: "Could not list team sessions", error })),
      )
      const access = yield* orchestra.accessMany(members.map((session) => session.id))
      const categories = yield* orchestra.categories(members.map((session) => session.id))
      const roles = yield* orchestra.roles(project.id)
      return members
        .filter((session) => access[session.id] !== "hidden" && !BrowserLifecycle.retired(String(session.id)))
        .map((session) => {
          const role = roles.find((item) => item.agent === session.agent)
          return {
            session,
            access: access[session.id],
            category: categories[session.id] ?? "Other",
            role: role?.id ?? session.agent ?? "default",
            mode: Mode.fromMetadata(session.metadata)?.id ?? (role ? Mode.defaultForRole(role)?.id : undefined),
          }
        })
    })

    const grouped = <T extends { category: string }>(rows: ReadonlyArray<T>, line: (row: T) => string) =>
      [...new Set(rows.map((row) => row.category))]
        .map((category) =>
          [`${category}:`, ...rows.filter((row) => row.category === category).map((row) => `- ${line(row)}`)].join(
            "\n",
          ),
        )
        .join("\n")

    const list = Effect.fnUntraced(function* (project: Orchestra.Project) {
      const rows = yield* team(project)
      if (rows.length === 0) return "No team sessions in this project yet. Create one with action create."
      const active = yield* sessions.active
      const pending = yield* Effect.forEach(rows, (row) => orchestra.pending(row.session.id))
      const outcomes = yield* orchestra.outcomes(project.id)
      const now = Date.now()
      return grouped(
        rows.map((row, index) => ({
          ...row,
          sent: pending[index],
          outcome: outcomes[row.session.id]?.at(-1)?.outcome,
        })),
        (row) =>
          [
            `${row.session.title ?? "(untitled)"} ${row.session.id}`,
            `role ${row.role}`,
            ...(row.mode ? [`mode ${row.mode}`] : []),
            active.has(row.session.id) ? "running" : "idle",
            `access ${row.access}`,
            ...(row.outcome ? [`last report ${row.outcome}`] : []),
            ...(row.sent === undefined
              ? []
              : [
                  `task outstanding (sent ${Math.round((now - row.sent) / 60_000)} min ago${
                    // A task unanswered for over an hour is stale, not just
                    // outstanding: the orchestrator should nudge, reassign
                    // or cancel it instead of assuming it is still in flight.
                    now - row.sent > 60 * 60_000 ? ", stale" : ""
                  })`,
                ]),
          ].join(" · "),
      )
    })

    yield* ctx.tool.transform((editor) => editor.add({
      name: "task_report",
      options: { codemode: false, core: true },
      description: "Record this task's typed outcome before your final plain-text report. This declares progress, not proof: checks and delivery evidence are verified independently. Call again if the outcome changes.",
      input: Schema.Struct({ outcome: Schema.Literals(["complete", "partial", "incomplete", "failed"]), summary: Schema.String }),
      output: Schema.Struct({ outcome: Schema.Literals(["complete", "partial", "incomplete", "failed"]), summary: Schema.String }),
      execute: (input) => Effect.succeed({ output: input, content: `Recorded task outcome: ${input.outcome}. ${input.summary}` }),
    }))
    // The 6-message rule, enforced: in a project's main session, after
    // ORCHESTRATOR_MESSAGE_LIMIT of the Orchestrator's own messages in a row
    // without a delegation, every other tool call is refused until a sessions
    // send/create carrying a task goes through. The count lives in memory per
    // session and is seeded from history on first sight, so a restart does
    // not hand back spent messages. Sessions that are not a project main are
    // never gated.
    const gateCounted = new Map<string, string[]>()
    const gateIncoming = new Map<string, string>()
    yield* ctx.tool.hook("execute.before", (event) =>
      Effect.gen(function* () {
        const project = yield* orchestra.mainOf(event.sessionID).pipe(Effect.orElseSucceed(() => undefined))
        if (!project || project.main !== event.sessionID) return
        // The newest messages, oldest first. Reading the oldest 100 (order asc) made a long chat count its first
        // messages, not its latest ones.
        const history = yield* sessions
          .messages({ sessionID: event.sessionID, limit: 100, order: "desc" })
          .pipe(
            Effect.map((list) => [...list].reverse()),
            Effect.orElseSucceed(() => [] as SessionMessage.Info[]),
          )
        const incoming = [...history].reverse().find((item) => item.type === "user" || item.type === "synthetic")
        const incomingID = incoming ? String(incoming.id) : ""
        let counted = gateCounted.get(event.sessionID)
        if (!counted) {
          const streak = Math.min(ownMessageStreak(history), ORCHESTRATOR_MESSAGE_LIMIT)
          counted = Array.from({ length: streak }, (_, index) => `history-${index}`)
          gateCounted.set(event.sessionID, counted)
          gateIncoming.set(event.sessionID, incomingID)
        } else if (incomingID !== "" && incomingID !== gateIncoming.get(event.sessionID)) {
          // A new incoming message (the operator's, or a <team-report> wake-up) starts a new cycle. Without this
          // the count never reset, and a chat of plain questions ended with every tool call refused for good.
          counted = []
          gateCounted.set(event.sessionID, counted)
          gateIncoming.set(event.sessionID, incomingID)
        }
        // The gate needs the action for more than the sessions tool: the
        // MCP survey (mcp_manager inspect) is exempt, so its action must
        // reach the gate too. Extracting it for every tool is safe — the
        // gate only treats an action as a delegation or a survey for the
        // exact tool names those belong to.
        const input =
          typeof event.input === "object" && event.input !== null
            ? (event.input as { action?: string; text?: string })
            : {}
        if (event.tool === name && (input.action === "send" || input.action === "create") && input.text?.trim()) {
          const user = history.findLastIndex(message => message.type === "user")
          const unread = SessionCompletionGate.unreadReportWorkers(history.slice(user + 1))
          if (unread.length) return yield* new Tool.Error({ message: `Read truncated worker reports before dispatching the next step: ${unread.join(", ")}. Use sessions action=read for those exact workers and review their complete evidence first.` })
        }
        const gate = delegationGate(counted, {
          tool: event.tool,
          messageID: String(event.messageID),
          action: input.action,
          text: input.text,
        })
        gateCounted.set(event.sessionID, [...gate.counted])
        if (gate.blocked)
          return yield* new Tool.Error({
            message: withoutDisabledMcpGuidance(`12-message rule: you have sent ${ORCHESTRATOR_MESSAGE_LIMIT} of your own messages in a row without handing a task to a team session, so this call is refused. Delegate now with the sessions tool (action send or create, with the task as text) — that call is always allowed and resets the count. A dispatch also needs a fresh MCP survey and an explicit mcp assignment: if you have not surveyed yet, run mcp_manager action=inspect first — it is always allowed, even at the limit — then dispatch with mcp (servers [] and maxCalls 0 when the task needs no MCP). Building the Society (society_forge found/generate, society_plan apply) is always allowed too. (This count restarts with every new message from the operator.)`),
          })
      }),
    )

    yield* ctx.tool
      .transform((editor) =>
        editor.add({
          name,
          options: { codemode: false, core: true, guide: dispatchGuide(), guideWithResult: true },
          description,
          input: Input,
          output: Output,
          execute: (input, context) =>
            Effect.gen(function* () {
              const desktopBlock = desktopDispatchDenial(input)
              if (desktopBlock) return yield* new ToolFailure({message:desktopBlock})
              const project = yield* orchestra.mainOf(context.sessionID)
              if (!project)
                return yield* new ToolFailure({ message: "Only a project's main session can manage sessions" })

        // Clean up sessionID if passed with quotes, backticks or formatting
        if (input.sessionID) {
          const cleaned = input.sessionID.trim().replace(/^[`*"]+|[`*"]+$/g, "")
          if (cleaned !== input.sessionID) {
            ;(input as any).sessionID = cleaned as SessionSchema.ID
          }
        }

        // A common slip: the model puts the target session ID in `text` and a
        // placeholder or nothing in `sessionID`. Recover by using `text` as the ID when it
        // names a real session.
        if (input.text?.trim().startsWith("ses_")) {
          const candidate = input.text.trim().replace(/^[`*"]+|[`*"]+$/g, "") as SessionSchema.ID
          if (input.sessionID) {
            const current = yield* sessions.get(input.sessionID).pipe(Effect.option)
            if (current._tag === "None") {
              const fallback = yield* sessions.get(candidate).pipe(Effect.option)
              if (fallback._tag === "Some") {
                ;(input as any).sessionID = candidate
                ;(input as any).text = undefined
              }
            }
          } else if (input.action !== "create" && input.action !== "send") {
            const fallback = yield* sessions.get(candidate).pipe(Effect.option)
            if (fallback._tag === "Some") {
              ;(input as any).sessionID = candidate
              ;(input as any).text = undefined
            }
          }
        }

              // What the Orchestrator already read while orienting travels with the
              // task, in full: the worker starts from the same pages instead of
              // paying for the same reconnaissance a second time. Only this
              // cycle's reads are attached (the scan stops at the latest
              // operator or wake-up message) and the newest read of a file
              // wins — but nothing is cut: a capped brief makes the worker
              // re-read the missing pages, which is exactly the waste this
              // exists to avoid. Read outputs are already bounded by the
              // runner, so no second cap belongs here.
              const reconBrief = Effect.fnUntraced(function* () {
                const messages = yield* sessions
                  .messages({ sessionID: context.sessionID, limit: 60, order: "desc" })
                  .pipe(Effect.orElseSucceed((): SessionMessage.Info[] => []))
                const seen = new Set<string>()
                const chunks: string[] = []
                const hashes: string[] = []
                for (const message of messages) {
                  if (message.type === "user" || message.type === "synthetic") break
                  if (message.type !== "assistant") continue
                  for (const part of message.content) {
                    if (part.type !== "tool" || part.name !== "read" || part.state.status !== "completed") continue
                    const input = part.state.input as {
                      files?: ReadonlyArray<{ path?: unknown } | string>
                      filePath?: unknown
                      path?: unknown
                    }
                    const paths = [
                      ...(input.files ?? []).flatMap((file) =>
                        typeof file === "string" ? [file] : typeof file?.path === "string" ? [file.path] : [],
                      ),
                      ...(typeof input.filePath === "string" ? [input.filePath] : []),
                      ...(typeof input.path === "string" ? [input.path] : []),
                    ]
                    if (paths.length === 0 || paths.every((path) => seen.has(path))) continue
                    const text = part.state.content
                      .flatMap((item) => (item.type === "text" ? [item.text] : []))
                      .join("\n")
                    if (!text) continue
                    paths.forEach((path) => seen.add(path))
                    chunks.push(text)
                    hashes.push(ReconDedup.digest(part.state.content))
                  }
                }
                if (chunks.length === 0) return undefined
                return { hashes, text: [
                  "[Reconnaissance already gathered by the Orchestrator — the files below were read before this dispatch, so their current content is attached. Do not re-read them unless you need a different range or they changed after your edits.]",
                  ...chunks.toReversed(),
                ].join("\n\n") }
              })
              const dispatch = (sessionID: SessionSchema.ID, text: string) =>
                Effect.gen(function* () {
                  // A turn a trigger started, without the operator's yes for publishing, hands nothing over that looks like
                  // sending, replying or posting in the operator's name.
                  const incomingHistory = yield* sessions
                    .messages({ sessionID: context.sessionID, limit: 40, order: "desc" })
                    .pipe(Effect.orElseSucceed((): SessionMessage.Info[] => []))
                  const blocked = Trigger.publishRefusal(incomingHistory as never, text)
                  if (blocked) return yield* new ToolFailure({ message: blocked })
                  // A worker that gets its task from a triggered turn cannot click, type or run scripts in a page
                  // (the browser tool checks this mark); a task from an ordinary turn lifts the mark.
                  const by = Trigger.triggered(incomingHistory as never)
                  const provenance: BrowserProvenance.Record = by && !by.publishApproved
                    ? { mode: "read-only", triggerID: by.id, ...(by.browserSessionID ? { browserSessionID: by.browserSessionID } : {}) }
                    : { mode: "ordinary" }
                  if (!(provenance.mode === "ordinary" ? BrowserProvenance.reset(String(sessionID)) : BrowserProvenance.write(String(sessionID), provenance)))
                    return yield* new ToolFailure({ message: "The browser task authority could not be saved. Nothing was dispatched; fix storage access and try again." })
                  if (by && !by.publishApproved) Trigger.taint(String(sessionID), by.id, Date.now(), by.browserSessionID)
                  else Trigger.clearTaint(String(sessionID))
                  if(input.workScope){
                    const scope=scopePaths(input.workScope)
                    if(!scope)return yield* new ToolFailure({message:"Invalid workScope: use exact project-relative paths without traversal or wildcards."})
                    const worker=yield* sessions.get(sessionID)
                    yield* sessions.setMetadata({sessionID,metadata:{...worker.metadata,[SCOPE_KEY]:scope}})
                  }else{
                    const worker=yield* sessions.get(sessionID)
                    const metadata={...worker.metadata};delete metadata[SCOPE_KEY]
                    yield* sessions.setMetadata({sessionID,metadata})
                  }
                  const recon = yield* reconBrief()
                  const target = yield* sessions.get(sessionID)
                  yield* sessions.setMetadata({ sessionID, metadata: { ...target.metadata, [ReconDedup.KEY]: recon?.hashes ?? [] } })
                  return yield* orchestra.dispatch({
                    project,
                    sessionID,
                    text: recon ? `${recon.text}\n\n${text}` : text,
                  })
                }).pipe(
                  Effect.mapError((error) => new ToolFailure({ message: `Could not send task: ${error.message}`, error })),
                )
              const roles = yield* orchestra.roles(project.id)
              // A mode changes how a session works, not what its role allows. `auto` clears the
              // stored override so the role's default applies again.
              const requireMode = Effect.fnUntraced(function* (id: string | undefined) {
                if (!id?.trim()) return undefined
                const mode = Mode.of(id)
                if (!mode)
                  return yield* new ToolFailure({
                    message: `Unknown work mode ${id}. Modes: ${Mode.list().join(", ")}`,
                  })
                return mode
              })
              const setMode = Effect.fnUntraced(function* (sessionID: SessionSchema.ID, mode: Mode.Spec) {
                const session = yield* sessions
                  .get(sessionID)
                  .pipe(Effect.mapError(() => new ToolFailure({ message: `Сессия не существует или недоступна: ${sessionID}. Обновите sessions list; не повторяйте отправку по старому ID.` })))
                const metadata = { ...(session.metadata ?? {}) }
                if (mode.id === "auto") delete metadata[Mode.MetadataKey]
                else metadata[Mode.MetadataKey] = mode.id
                yield* sessions.setMetadata({ sessionID, metadata }).pipe(
                  Effect.mapError((error) => new ToolFailure({ message: `Could not set mode for ${sessionID}`, error })),
                )
              })
              // New workers start in their role's default mode; an existing worker keeps the
              // mode the operator or the Orchestrator already chose unless one is passed now.
              const applyMode = Effect.fnUntraced(function* (
                session: SessionSchema.Info,
                role: Orchestra.Role | undefined,
                requested: Mode.Spec | undefined,
              ) {
                if (requested) return yield* setMode(session.id, requested)
                if (Mode.fromMetadata(session.metadata) || !role) return
                const fallback = Mode.defaultForRole(role)
                if (fallback) yield* setMode(session.id, fallback)
              })
              // The Orchestrator's automatic choices for one task: a model from the role's list
              // and a narrower tool set. Both are checked against what the operator allowed.
              const choose = Effect.fnUntraced(function* (
                role: Orchestra.Role | undefined,
                text?: string,
                mode?: Mode.Spec,
              ) {
                const explicit = input.model?.trim() || undefined
                const routed = explicit === undefined ? yield* routeModel(role, text, mode) : undefined
                const model = explicit !== undefined ? yield* requireModel(role, explicit) : routed?.ref
                const modelSource = explicit !== undefined ? "your explicit choice" : routed?.source
                const tools = input.tools?.map((tool) => tool.trim()).filter(Boolean)
                if (tools && !role?.autoTools)
                  return yield* new ToolFailure({
                    message: `${role?.name ?? "This session"} does not let the Orchestrator change its tools; omit tools`,
                  })
                // The ceiling is the role's effective toolkit: its explicit list,
                // or its kind's toolkit when the role declares none (RoleToolkits).
                // A role without a list used to have no ceiling at all here.
                const audit = tools ? RoleToolkits.auditTools(role, tools) : undefined
                const outside = audit?.outside.filter((entry) => entry.tool !== "all")
                if (outside?.length)
                  return yield* new ToolFailure({
                    message: `${role?.name} may not use ${outside.map((entry) => entry.tool).join(", ")}; its tools are ${RoleToolkits.effectiveTools(role)?.join(", ")}`,
                  })
                if (tools?.includes("all"))
                  yield* Effect.logWarning("role runs unrestricted for this task (tools \"all\" lifts its toolkit ceiling)", {
                    role: role?.id,
                    kind: role ? RoleToolkits.kindOfRole(role) : undefined,
                  })
                return {
                  model,
                  ...(modelSource === undefined ? {} : { modelSource }),
                  permissions: tools ? (tools.includes("all") ? [] : Orchestra.toolRules(tools)) : undefined,
                }
              })
              const apply = Effect.fnUntraced(function* (
                sessionID: SessionSchema.ID,
                choice: { model?: Model.Ref; permissions?: Permission.Ruleset },
              ) {
                if (choice.model)
                  yield* sessions.switchModel({ sessionID, model: choice.model }).pipe(
                    Effect.mapError((error) => new ToolFailure({ message: `Could not switch model for ${sessionID}`, error })),
                  )
                if (choice.permissions) {
                  // Replacing the set wholesale silently dropped the denies the operator or
                  // an earlier dispatch stamped on the session, so the new allow set ran
                  // without them. Denies are restrictions, never grants, so they survive a
                  // re-apply — and a new set that would lift one is refused instead.
                  // Two exceptions, both re-derived on every dispatch: the `*` catch-all
                  // deny the tool rules themselves start with, and the per-server MCP
                  // denies `distributeMcp` stamps right after this runs.
                  const session = yield* sessions
                    .get(sessionID)
                    .pipe(Effect.mapError(() => new ToolFailure({ message: `Session not found: ${sessionID}` })))
                  const kept = (session.permissions ?? []).filter(
                    (rule) =>
                      rule.effect === "deny" &&
                      !(rule.action === "*" && rule.resource === "*") &&
                      !/^[^*]+_\*$/.test(rule.action),
                  )
                  for (const deny of kept) {
                    if (Permission.evaluate(deny.action, deny.resource, choice.permissions).effect === "allow")
                      return yield* new ToolFailure({
                        message: `Refusing to replace the permissions of ${sessionID}: the new set would allow ${deny.action} ${deny.resource}, which this session denies. Ask the operator to lift the deny first.`,
                      })
                  }
                  yield* sessions
                    .setPermissions({ sessionID, permissions: [...kept, ...choice.permissions] })
                    .pipe(
                      Effect.mapError((error) => new ToolFailure({ message: `Could not set permissions for ${sessionID}`, error })),
                    )
                }
              })
              // The servers anyone can name for deny rules: the roles' own lists plus
              // whatever the MCP service currently knows (configured or discovered).
              const knownServers = Effect.fnUntraced(function* () {
                const fromRoles = roles.flatMap((role) => {
                  const servers = mcpServersOf(role)
                  return servers === "all" ? [] : [...servers]
                })
                if (Option.isNone(mcp)) return [...new Set(fromRoles)].toSorted()
                const infos = yield* mcp.value.servers().pipe(Effect.orElseSucceed(() => [] as Mcp.ServerInfo[]))
                const tools = yield* mcp.value.tools().pipe(Effect.orElseSucceed(() => [] as Mcp.Tool[]))
                return [
                  ...new Set([...fromRoles, ...infos.map((info) => String(info.name)), ...tools.map((tool) => String(tool.server))]),
                ].toSorted()
              })
              // Distribute the MCP limit the Orchestrator passed for this task: checked
              // against the role's ceiling, enforced by replacing the previous task's
              // generated deny rules for the servers outside the allowlist with the new
              // set (last match wins), stamped on the session metadata, and returned so
              // the caller can state it at the top of the task brief. A dispatch to a role
              // session without an `mcp` field is refused (see the gate below).
              const distributeMcp = Effect.fnUntraced(function* (
                sessionID: SessionSchema.ID,
                role: Orchestra.Role | undefined,
              ) {
                if (!role) {
                  if (input.mcp !== undefined)
                    return yield* new ToolFailure({ message: "This session has no team role, so it has no MCP ceiling to distribute from; omit mcp" })
                  return undefined
                }
                const session = yield* sessions
                  .get(sessionID)
                  .pipe(Effect.mapError(() => new ToolFailure({ message: `Session not found: ${sessionID}` })))
                // The assignment must be an informed decision, not a default filled in
                // to satisfy the gate below: before the first dispatch in this session
                // the Orchestrator has to survey the fleet once — mcp_manager inspect
                // stamps this session when it runs. An empty assignment after the
                // survey is a valid answer; the same assignment without one is a
                // guess, so it is refused here, in code, the same way a missing
                // assignment is. A survey goes stale: after SURVEY_TTL_MS the fleet
                // may have changed (a server died, a new one was installed), so a
                // dispatch on a stale survey is refused until the fleet is
                // surveyed again.
                const mcpEnabled = process.env.ORCHESTRA_MCP === "1"
                if (mcpEnabled && Option.isSome(mcp)) {
                  const self = yield* sessions.get(context.sessionID).pipe(Effect.orElseSucceed(() => undefined))
                  if (!McpSurvey.isFresh(self?.metadata)) {
                    const configured = yield* mcp.value
                      .servers()
                      .pipe(Effect.map((infos) => infos.length), Effect.orElseSucceed(() => 0))
                    return yield* new ToolFailure({
                      message: `No fresh MCP survey: before the first dispatch, call mcp_manager with action=inspect once — it lists the configured servers (status, discovered tools, leases) and the ${McpCatalog.all.length} installable catalog servers — then dispatch with an explicit mcp assignment based on what you saw (${configured} server(s) currently configured). A survey older than ${McpSurvey.SURVEY_TTL_MS / 60_000} minutes is stale: run inspect again. An assignment of { servers: [], maxCalls: 0 } is valid after the survey; before it, it is a guess. Nothing was sent.`,
                    })
                  }
                }
                // The MCP assignment is a mandatory part of every dispatch to a role
                // session — enforced here, in code, not left to the prompt: a dispatch
                // without an `mcp` field is refused, so the Orchestrator must state the
                // grant for every task, including "no MCP" (servers: [], maxCalls: 0).
                // The earlier inherited-ceiling default let dispatches through with an
                // implicit grant the operator never saw decided; that is exactly the
                // failure this gate exists to make impossible. (Assignment records
                // stamped before the gate may still carry explicit: false.)
                if (mcpEnabled && input.mcp === undefined) {
                  return yield* new ToolFailure({
                    message:
                      "No MCP assignment: every dispatch to a team session must pass an explicit mcp object — the servers this task may use and maxCalls (the role's ceiling is in your context). If the task needs no MCP, pass mcp: { servers: [], maxCalls: 0 }. Nothing was sent.",
                  })
                }
                const resolution = resolveMcpLimit(role, mcpEnabled ? input.mcp : { servers: [], maxCalls: 0 })
                if (!resolution.ok) return yield* new ToolFailure({ message: resolution.message })
                const limit = resolution.limit
                // The previous task's generated denies come out before the
                // new ones go in: a reused worker otherwise keeps every
                // task's denies forever. Which servers the previous dispatch
                // denied is stamped on the session (records from before that
                // fall back to recomputing from the previous allowlist); a
                // rule the operator set by hand is never in that set, so it
                // stays. The write happens whenever the ruleset actually
                // changes — including when the new task allows everything and
                // the old denies simply come off.
                const known = yield* knownServers()
                const previous = mcpAssignmentOf(session.metadata)
                const previousDeny =
                  previous === undefined
                    ? []
                    : previous.deniedServers !== undefined
                      ? denyRulesForServers(previous.deniedServers)
                      : mcpDenyRules(previous, known)
                const deniedServers =
                  limit.servers === "all"
                    ? []
                    : [...new Set(known)].filter((server) => !limit.servers.includes(server)).toSorted()
                const deny = denyRulesForServers(deniedServers)
                const permissions = [...withoutMcpDenyRules(session.permissions ?? [], previousDeny), ...deny]
                if (JSON.stringify(permissions) !== JSON.stringify(session.permissions ?? []))
                  yield* sessions
                    .setPermissions({ sessionID, permissions })
                    .pipe(
                      Effect.mapError(
                        (error) => new ToolFailure({ message: `Could not apply the MCP limit to ${sessionID}`, error }),
                      ),
                    )
                // A fresh epoch per hand-out: the budget gate restarts the session's
                // counters when the epoch changes, so a new task never inherits the
                // previous task's usage even when the limit values are identical. The
                // assignment record carries the same epoch, tying the sidebar's view
                // of the grant to the exact budget the gate enforces.
                const budgetEpoch = crypto.randomUUID()
                yield* sessions
                  .setMetadata({
                    sessionID,
                    metadata: {
                      ...(session.metadata ?? {}),
                      [MCP_LIMIT_METADATA_KEY]: {
                        ...(JSON.parse(JSON.stringify(limit)) as Record<string, Schema.Json>),
                        budgetEpoch,
                      } as Schema.Json,
                      [MCP_ASSIGNMENT_METADATA_KEY]: {
                        ...(JSON.parse(JSON.stringify(limit)) as Record<string, Schema.Json>),
                        explicit: true,
                        budgetEpoch,
                        assignedAt: Date.now(),
                        // The servers this dispatch denied, so the next one
                        // removes exactly these generated rules and no others.
                        deniedServers: [...deniedServers],
                      } as Schema.Json,
                    },
                  })
                  .pipe(
                    Effect.mapError(
                      (error) => new ToolFailure({ message: `Could not stamp the MCP limit on ${sessionID}`, error }),
                    ),
                  )
                return limit
              })
              // Every dispatch result names the model the worker will run and where
              // that choice came from, so an inherited flagship is visible as the
              // default it is instead of passing as a decision. The variant rides
              // along: a default the tool filled in (#medium) must read as one.
              const modelNote = (
                model: { providerID: string; id: string; variant?: string } | undefined,
                source: string,
              ) =>
                model
                  ? ` Model: ${model.providerID}/${model.id}${model.variant && model.variant !== "default" ? `#${model.variant}` : ""} (${source}).`
                  : ""
              const busy = (sessionID: SessionSchema.ID) =>
                Effect.gen(function* () {
                  if ((yield* orchestra.pending(sessionID)) === undefined) return
                  return yield* new ToolFailure({
                    message: `Session ${sessionID} already has an outstanding task. Wait for its <team-report> before sending another.`,
                  })
                })

              switch (input.action) {
                case "list":
                  return { output: yield* list(project) }
                case "read": {
                  const session = yield* target(project, input.sessionID, "read")
                  const isPending = (yield* orchestra.pending(session.id)) !== undefined
                  const messages = yield* sessions
                    .messages({ sessionID: session.id, limit: input.limit ?? 10, order: "desc" })
                    .pipe(Effect.mapError((error) => new ToolFailure({ message: "Could not read the session", error })))
                  let text = messages.toReversed().flatMap(render).join("\n\n") || "The session has no messages yet."
                  if (isPending) {
                    text += "\n\n[NOTICE: This worker is currently actively executing a task. Do NOT poll this session with repeated read or list calls. Its <team-report> will be delivered to you automatically upon completion. End your turn now and wait.]"
                  }
                  return { sessionID: session.id, output: text }
                }
                case "send": {
                  const session = yield* target(project, input.sessionID, "write")
                  if (!input.text?.trim()) return yield* new ToolFailure({ message: "Pass the message as text" })
                  yield* busy(session.id)
                  const role = roles.find((item) => item.agent === session.agent)
                  const wrongRoute = browserRouteRefusal(role?.id, input.text)
                  if (wrongRoute) return yield* new ToolFailure({ message: wrongRoute })
                  const mode = yield* requireMode(input.mode)
                  const choice = yield* choose(
                    role,
                    input.text,
                    mode ?? Mode.fromMetadata(session.metadata) ?? (role ? Mode.defaultForRole(role) : undefined),
                  )
                  yield* apply(session.id, choice)
                  yield* applyMode(session, role, mode)
                  const limit = yield* distributeMcp(session.id, role)
                  yield* dispatch(session.id, limit && mcpBriefLine(limit) ? `${mcpBriefLine(limit)}\n\n${input.text}` : input.text)
                  return {
                    sessionID: session.id,
                    output: `Sent. VERIFIED: id ${session.id}, title "${session.title ?? ""}", role ${role?.id ?? session.agent ?? "session"}; task accepted by the session service. Its report will arrive here when it finishes. Dispatch other ready independent work now; then wait for reports, do NOT poll with read or list.${modelNote(choice.model ?? session.model, choice.model ? (choice.modelSource ?? "your explicit choice") : "the session's existing model")}`,
                  }
                }
                case "create": {
                  const role = roles.find((item) => item.id === input.role)
                  // A role is required: without one the session runs the default agent under
                  // whatever title the model invents ("Architect"), a member the roster never had.
                  if (!role)
                    return yield* new ToolFailure({
                      message: `${input.role ? `Unknown role ${input.role}` : "Pass a role"}. Roles: ${roles.map((role) => role.id).join(", ")}`,
                    })
                  const wrongRoute = browserRouteRefusal(role.id, input.text)
                  if (wrongRoute) return yield* new ToolFailure({ message: wrongRoute })
                  const mode = yield* requireMode(input.mode)
                  const choice = yield* choose(role, input.text, mode ?? Mode.defaultForRole(role))

                  // Reuse the project's existing worker by role before creating anything.
                  // A new instance is an explicit opt-in, not the default response to a new task.
                  // Every browser session is its own page and its own BrowserAgent, so a request for one more is never a reuse.
                  if (!input.newInstance && role.id !== "browser-agent") {
                    const rows = yield* team(project)
                    const matching = rows.filter((row) => row.role === role.id)
                    if (matching.length > 0) {
                      const active=yield* sessions.active
                      const pending = new Set<string>()
                      for (const row of matching) {
                        if (active.has(row.session.id) || (yield* orchestra.pending(row.session.id)) !== undefined) pending.add(row.session.id)
                      }
                      const reusable = reusableWorker(rows, role.id, pending)
                      if (reusable.session) {
                        const existing = reusable.session.session
                        yield* apply(existing.id, choice)
                        yield* applyMode(existing, role, mode)
                        const limit = yield* distributeMcp(existing.id, role)
                        if (input.text?.trim())
                          yield* dispatch(existing.id, limit && mcpBriefLine(limit) ? `${mcpBriefLine(limit)}\n\n${input.text}` : input.text)
                        return {
                          sessionID: existing.id,
                          output: input.text?.trim()
                            ? `Reused existing ${role.name} session ${existing.title ?? existing.id}; task queued. Its report will arrive here when it finishes. Dispatch other ready independent work now; then wait for reports, do NOT poll with read or list.${modelNote(choice.model ?? existing.model, choice.model ? (choice.modelSource ?? "your explicit choice") : "the session's existing model")}`
                            : `Reused existing ${role.name} session ${existing.title ?? existing.id}. No new session was created; use action send to assign work.`,
                        }
                      }
                      if (reusable.writable.length === 0) {
                        return yield* new ToolFailure({
                          message: `An existing ${role.name} session is read-only, so no work can go to it. Do not create a duplicate. Use a ${role.name} session that has write access, or tell the operator which session needs write access and why.`,
                        })
                      }
                      if(!input.text?.trim() || !disjointScopes(input.workScope,reusable.writable.map(row=>row.session.metadata?.[SCOPE_KEY])))return yield* new ToolFailure({
                        message: `All existing ${role.name} sessions have an outstanding task. Independent disjoint work can be staffed automatically: pass workScope with exact project-relative paths, with existing workers' scopes known. Overlapping/dependent/unknown scope waits for the report. No duplicate session was created.`,
                      })
                    }
                  }

                  // A role without its own model runs on the operator's Feature picks, then on the
                  // `orchestra.worker` policy, then on the orchestrator's model, the one the operator
                  // picked, rather than the server's first catalog model. An explicit task model still
                  // wins.
                  const main = yield* sessions.get(context.sessionID).pipe(Effect.option)
                  const favorites = yield* Orchestra.workerFavorites
                  const available = Option.isNone(catalog) ? [] : yield* catalog.value.available()
                  const worker = Orchestra.workerModels(yield* Orchestra.workerPolicy, role, { favorites, catalog: available })
                  // The core service holds the project lifecycle lock across ownership, creation,
                  // access and category writes; removal cannot leave a half-created member behind.
                  const created = yield* orchestra
                    .createMember({
                      project,
                      title:
                        role.id === "browser-agent"
                          ? browserSessionTitle(input.title, input.text)
                          : input.title?.trim() || undefined,
                      agent: role.agent,
                      model: choice.model ?? worker.model ?? Option.getOrUndefined(main)?.model,
                      models: worker.models,
                      category: input.category,
                    })
                    .pipe(
                      Effect.mapError((error) => new ToolFailure({ message: `Could not create a session: ${error.message}`, error })),
                    )
                  if (choice.permissions)
                    yield* sessions.setPermissions({ sessionID: created.id, permissions: choice.permissions }).pipe(
                      Effect.mapError((error) =>
                        new ToolFailure({ message: `Could not set permissions for ${created.id}`, error }),
                      ),
                    )
                  yield* applyMode(created, role, mode)
                  const limit = yield* distributeMcp(created.id, role)
                  if (input.text?.trim())
                    yield* dispatch(created.id, limit && mcpBriefLine(limit) ? `${mcpBriefLine(limit)}\n\n${input.text}` : input.text)
                  // What is reported is what was read back from the session store, not what was asked for.
                  const confirmed = yield* sessions.get(created.id).pipe(Effect.option)
                  if (Option.isNone(confirmed))
                    return yield* new ToolFailure({
                      message: `NOT CONFIRMED: ${created.id} cannot be read back after creation. Treat it as not created: retry once, then tell the operator it failed.`,
                    })
                  return {
                    sessionID: created.id,
                    output: `Created. VERIFIED: id ${created.id}, title "${confirmed.value.title ?? ""}", role ${role.id}, agent ${confirmed.value.agent ?? role.agent}, project ${project.directory}; listed in the operator's project tree${input.text?.trim() ? "; task queued. Its report will arrive here when it finishes. Dispatch other ready independent work now; then wait for reports, do NOT poll with read or list." : "; NO TASK WAS SENT: nothing is running in it and no report will ever arrive. Do not tell the operator that it is working or launched. Send the task now with sessions action=send, then wait for its report."}.${modelNote(created.model, choice.model ? (choice.modelSource ?? "your explicit choice") : worker.model ? "the role/worker policy" : "inherited from your own session — pass model to choose otherwise")}`,
                  }
                }
                case "answer": {
                  const session = yield* target(project, input.sessionID, "write")
                  const answers = input.answers ?? []
                  if (answers.length === 0) return yield* new ToolFailure({ message: "Pass answers, one list per question" })
                  // The worker's oldest open question; the human may already have answered it in the worker.
                  const form = (yield* forms.list({ sessionID: session.id })).find(
                    (item) => Orchestra.isForwardedForm(item.metadata?.kind),
                  )
                  if (!form)
                    return yield* new ToolFailure({
                      message: `${session.title ?? session.id} has no open question; it may already have been answered or dismissed.`,
                    })
                  if (answers.length !== form.fields.length)
                    return yield* new ToolFailure({
                      message: `The question has ${form.fields.length} part(s); pass exactly that many answers, in order.`,
                    })
                  const formatAnswer = (field: Form.Field, values: ReadonlyArray<string> | undefined) => {
                    const list = values ?? []
                    if (field.type === "multiselect") return [...list]
                    if (field.type === "boolean") {
                      const raw = (list[0] ?? "").trim().toLowerCase()
                      return raw === "true" || raw === "yes" || raw === "1" || raw === "y"
                    }
                    if (field.type === "number" || field.type === "integer") {
                      const num = Number(list[0])
                      return Number.isFinite(num) ? num : (list[0] ?? "")
                    }
                    return list.join(", ")
                  }
                  // The worker's transcript shows who answered, so an AI decision is never mistaken for the operator's.
                  const asked = form.metadata?.tool as { messageID?: string; id?: string } | undefined
                  if (asked?.messageID && asked.id)
                    FormDecision.note(FormDecision.key(asked.messageID, asked.id), {
                      by: `${project.name} Orchestrator`,
                      ...(input.reason?.trim() ? { reason: input.reason.trim().slice(0, 300) } : {}),
                    })
                  yield* forms
                    .reply({
                      id: form.id,
                      answer: Object.fromEntries(
                        form.fields.map((field, index) => [
                          field.key,
                          formatAnswer(field, answers[index]),
                        ]),
                      ),
                    })
                    .pipe(Effect.mapError((error) => new ToolFailure({ message: `Could not answer: ${error.message}`, error })))
                  return {
                    sessionID: session.id,
                    output: `Answered ${session.title ?? session.id}'s question; it continues its task and its report will arrive here.`,
                  }
                }
                case "set_mode": {
                  const session = yield* target(project, input.sessionID, "write")
                  const mode = yield* requireMode(input.mode)
                  if (!mode) return yield* new ToolFailure({ message: "Pass mode to set_mode" })
                  yield* setMode(session.id, mode)
                  return {
                    sessionID: session.id,
                    output: `${session.title ?? session.id} now works in the ${mode.name} mode (${mode.id}) from its next task.`,
                  }
                }
                case "set_model": {
                  // Only the Orchestrator changes a worker's model; a worker never does it by itself.
                  const session = yield* target(project, input.sessionID, "write")
                  if (!input.model?.trim()) return yield* new ToolFailure({ message: "Pass model (provider/model) to set_model" })
                  const role = roles.find((item) => item.agent === session.agent)
                  const choice = yield* choose(role)
                  if (choice.model) yield* apply(session.id, { model: choice.model })
                  return {
                    sessionID: session.id,
                    output: `${session.title ?? session.id} now runs on ${choice.model ? modelRef(choice.model) : input.model}. Send the task again.`,
                  }
                }
                case "stop": {
                  const session = yield* target(project, input.sessionID, "full")
                  const stopped = yield* sessions.interrupt(session.id)
                  return { sessionID: session.id, output: stopped ? "Stopped." : "The session was not running." }
                }
                case "plan": {
                  if (!input.stages || input.stages.length === 0)
                    return yield* new ToolFailure({ message: "Pass stages: the plan as a list of stage definitions" })
                  const planned = yield* orchestra
                    .planStages(project.id, input.stages)
                    .pipe(Effect.mapError((error) => new ToolFailure({ message: error.message, error })))
                  return { output: `Plan saved.\n\n${OrchestraStage.render(planned)}` }
                }
                case "stages": {
                  return { output: OrchestraStage.render(yield* orchestra.stages(project.id)) }
                }
                case "stage": {
                  if (!input.stage) return yield* new ToolFailure({ message: "Pass stage: the id of the stage to update" })
                  if (input.status === undefined && input.result === undefined)
                    return yield* new ToolFailure({ message: "Pass status and/or result for the stage update" })
                  const updated = yield* orchestra
                    .setStage(project.id, input.stage, {
                      ...(input.status ? { status: input.status } : {}),
                      ...(input.result !== undefined ? { result: input.result } : {}),
                    })
                    .pipe(Effect.mapError((error) => new ToolFailure({ message: error.message, error })))
                  const current = yield* orchestra.stages(project.id)
                  return { output: `Stage updated: ${OrchestraStage.describe(current, updated)}` }
                }
                case "verify": {
                  if (!input.criteria || input.criteria.length === 0)
                    return yield* new ToolFailure({
                      message: "Pass criteria: the acceptance criteria to score, one per item",
                    })
                  if (!input.items || input.items.length === 0)
                    return yield* new ToolFailure({
                      message: "Pass items: one entry per criterion, each with a status and its real evidence",
                    })
                  return { output: OrchestraStage.verifyAcceptance(input.criteria, input.items).report }
                }
                case "acquire_mcp": {
                  if (Option.isNone(mcp))
                    return yield* new ToolFailure({
                      message: "The MCP service is not available in this location, so no server can be acquired.",
                    })
                  let id = input.server?.trim()
                  let considered = ""
                  if (!id) {
                    if (!input.need?.trim())
                      return yield* new ToolFailure({
                        message: "Pass server (an exact catalog id) or need (a capability in words, e.g. \"browser automation\")",
                      })
                    const matches = McpAcquire.select(input.need)
                    if (matches.length === 0)
                      return {
                        output: `No MCP catalog entry matches "${input.need}". Native tools may already cover it; only when the capability is genuinely absent should a custom server be built with mcp_forge.`,
                      }
                    id = matches[0]!.entry.id
                    considered = ` Selected from the catalog (matched: ${matches[0]!.reasons.join(", ")}); other matches: ${matches.slice(1, 4).map((match) => match.entry.id).join(", ") || "none"}.`
                  }
                  if (input.role) {
                    const role = roles.find((item) => item.id === input.role)
                    if (!role)
                      return yield* new ToolFailure({
                        message: `Unknown role ${input.role}. Roles: ${roles.map((item) => item.id).join(", ")}`,
                      })
                    const refusal = acquireCeiling(role, id)
                    if (refusal) return yield* new ToolFailure({ message: refusal })
                  }
                  const ensured = yield* McpAcquire.ensure(mcp.value, id)
                  return {
                    output: `${ensured.detail} [state: ${ensured.state}; action: ${ensured.action}]${ensured.tools.length > 0 ? ` Tools: ${ensured.tools.join(", ")}.` : ""}${considered}`,
                  }
                }
              }
            }).pipe(
              Effect.map((output) => ({
                output,
                content: output.output,
                metadata: output.sessionID ? { sessionID: output.sessionID } : {},
              })),
            ),
        }),
      )
      .pipe(Effect.orDie)

    // The tool only exists for the project's main session; every other session
    // never sees it, so it cannot be prompted into managing its siblings.
    const hook = (event: SessionHooks["context"]) =>
      Effect.gen(function* () {
        if (!event.tools[name]) return
        if (!(yield* orchestra.mainOf(event.sessionID))) delete event.tools[name]
      })
    const deliveryCheckpoints = new Map<string,{ user: string; block: string }>()
    // The main session also gets its team roster with every request. Status is left
    // out: it changes during a turn, and the stable roster keeps the prompt cacheable.
    yield* ctx.session.hook("context", (event) =>
      Effect.gen(function* () {
        yield* hook(event)
        if (!event.tools[name]) return
        const project = yield* orchestra.mainOf(event.sessionID)
        if (!project) return
        const checkpointHistory = yield* sessions.messages({sessionID:event.sessionID,limit:60,order:"desc"}).pipe(Effect.orElseSucceed(()=>[] as SessionMessage.Info[]))
        const user = String(checkpointHistory.find(message=>message.type === "user")?.id ?? "boot")
        let checkpoint=deliveryCheckpoints.get(String(event.sessionID))
        if(!checkpoint || checkpoint.user !== user){
          const state=yield* Effect.promise(()=>DeliveryRecall.inspect(project.directory))
          checkpoint={user,block:DeliveryRecall.block(state)}
          if(deliveryCheckpoints.size>128)deliveryCheckpoints.clear()
          deliveryCheckpoints.set(String(event.sessionID),checkpoint)
        }
        event.system.push({type:"text",text:checkpoint.block})
        const rows = yield* team(project).pipe(Effect.orElseSucceed(() => []))
        const roles = yield* orchestra.roles(project.id)
        const playbook = yield* orchestra.playbook(project.id)
        const outcomes = yield* orchestra.outcomes(project.id)
        event.system.push({
          type: "text",
          text: [
            `# Your team — project "${project.name}" (${project.directory})`,
            rows.length === 0
              ? "The team has no sessions yet. No session exists until you create it with the sessions tool, action create."
              : [
                  "These are all the sessions of the team; no other session exists. Name and address them only by these titles and IDs.",
                  grouped(
                    rows,
                    (row) =>
                      [
                        `${row.session.title ?? "(untitled)"} ${row.session.id}`,
                        `role ${row.role}`,
                        ...(row.mode ? [`mode ${row.mode}`] : []),
                        `access ${row.access}`,
                        ...(outcomes[row.session.id]?.length
                          ? [`last report ${outcomes[row.session.id]?.at(-1)?.outcome}`]
                          : []),
                      ].join(" · "),
                  ),
                ].join("\n"),
            "",
            "Team workflow rules (mandatory):",
            "- This roster is not a staffing ceiling. Reuse an idle writable worker; otherwise sessions create with role, text and mcp. Use newInstance=true only for independent disjoint work while same-role workers are busy. Never bypass read-only access; all workers stay in this project.",
            "- Each session has a work mode (auto, fast, coding, research, planning, review, debug, design, ops). Set it with action set_mode or pass mode to send/create. A mode changes how the worker works and may make it read-only; it never widens the role's permissions.",
            "- Page actions in a browser session go to that session's BrowserAgent chat (browser action sessions lists its id) with action send; you only look at the page yourself (sessions, info, text, screenshot).",
            "- Copy the complete session ID exactly from this roster. Never truncate, infer, or substitute an ID.",
            "- Dispatch all ready independent work in this turn, then wait silently for task-linked <team-report> wakeups. Do not send repeated waiting messages, poll, or start another turn merely because DoD is open. One successful send is progress, not completion. Plan the next wave and choose roles/MCP yourself; ask only for an operator-only action, never how to solve or whether to continue.",
            "- After each <team-report>, compare the worker's evidence with the original acceptance criteria. outcome=partial, incomplete, failed, or stopped means the task is still open unless explicitly blocked/cancelled (outcome=unknown: judge the report text itself): inspect the report and send a specific follow-up to the same worker once its previous task is no longer outstanding. outcome=complete is evidence to review, not a substitute for checking the criteria. A report containing (cut; read the worker session for the rest) must be read with sessions action=read for that exact worker before completion.",
            "- A <team-question> means a worker is blocked waiting for an answer. Answer it with action answer yourself by default, and pass reason: one short sentence on why, which the operator sees next to your answer. Ask the operator only for hard limits: spending money, secrets through the masked Vault form (never chat or .env), publishing or other irreversible outside actions.",
            "- If a sessions tool call fails, inspect its exact error and use list/read to verify IDs and whether a task is outstanding. Fix the arguments or underlying cause before retrying; never repeat the identical failed call.",
            "- Do not call HTTP endpoints directly or guess /api/orchestra routes. If a tool/API error occurs, report its exact message and do not create a replacement session as a workaround.",
            "",
            ...(playbook
              ? [
                  "",
                  `# Team playbook — "${playbook.name}"`,
                  "This project was opened with this team. Follow its playbook unless the operator asks otherwise; scale it down for small requests.",
                  playbook.text,
                ]
              : []),
            "",
            "Roles you can create a session with (action create, role id):",
            ...roles.map((role) => `- ${role.id} (${role.name}, ${role.category}${role.readOnly ? ", read-only" : ""}): ${role.description}${setup(role)}`),
          ].join("\n"),
        })
        // The workflow stages ride in their own block for the same reason as the
        // delegation status below: stage state changes during a turn, so it must
        // not destabilize the cacheable roster block above.
        const stages = yield* orchestra.stages(project.id)
        if(stages.length){
          const ready=stages.filter(stage=>stage.status==="planned"&&stage.dependsOn.every(id=>stages.find(other=>other.id===id)?.status==="completed"))
          event.system.push({type:"text",text:`Next dependency wave: ${ready.map(stage=>`${stage.id} (${stage.roles.join(",")||"choose role"}; acceptance: ${stage.acceptance||"define evidence"})`).join("; ")||"none ready; inspect running/blockers, do not invent completion"}. Staff ready work yourself using sessions create/send; no roster ceiling. Check reports before completing dependencies.`})
        }
        if (stages.length > 0)
          event.system.push({
            type: "text",
            text: [
              "# Workflow stages",
              OrchestraStage.render(stages),
              "",
              "Stage rules (mandatory):",
              "- Start a stage only when it is ready (every stage it depends on completed): mark it running with action stage when you dispatch its work.",
              "- Complete a stage only with evidence: action stage with status completed requires result naming the evidence (a report, a test run, a commit). A worker's claim alone is not evidence.",
              "- When a discovery changes the plan, replan with action plan. Completed stages are preserved exactly as recorded; never rewrite their history.",
              "- The overall task is complete only when every stage is completed or explicitly cancelled and the combined result has been checked against the goal.",
            ].join("\n"),
          })
        // The 6-message rule status rides in its own block so the roster above
        // stays stable and cacheable; only this small tail changes per request.
        const history = yield* sessions
          .messages({ sessionID: event.sessionID, limit: 100, order: "desc" })
          .pipe(
            Effect.map((list) => [...list].reverse()),
            Effect.orElseSucceed(() => [] as SessionMessage.Info[]),
          )
        event.system.push({ type: "text", text: delegationStatus(ownMessageStreak(history)).text })
      }),
    )
    yield* ctx.session.hook("compaction", hook)
    yield* ctx.session.hook("generate", hook)
  }),
}

// How a role is set up, when the operator changed anything the Orchestrator has to respect.
function setup(role: Orchestra.Role) {
  const parts = [
    `mode ${role.mode ?? Mode.defaultForRole(role)?.id ?? "auto"}`,
    role.models?.length
      ? `model: you choose per task from ${role.models.join(", ")}`
      : role.model
        ? `model ${role.model}`
        : "model: your own unless you pass model",
    role.tools ? `tools: ${role.tools.join(", ")}` : "",
    role.autoTools ? "you may narrow its tools per task" : "",
    role.hub ? `hub categories: ${role.hub.join(", ") || "none"}` : "",
    role.registry ? `registry programs: ${role.registry.join(", ") || "none"}` : "",
  ].filter(Boolean)
  return parts.length > 0 ? ` [${parts.join("; ")}]` : ""
}

function render(message: SessionMessage.Info) {
  if (message.type === "user") return [`[user] ${message.text}`]
  if (message.type === "synthetic") return [`[note] ${message.text}`]
  if (message.type !== "assistant") return []
  const text = message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")
  const tools = message.content.flatMap((part) => (part.type === "tool" ? [part.name] : []))
  return [`[assistant] ${text}${tools.length > 0 ? `\n(tools: ${tools.join(", ")})` : ""}`]
}
