// Pure model for the sidebar's MCP sections.
//
// The sidebar answers one question — "which MCP servers did the Orchestrator
// actually grant to this session (and to its team workers)?" — from the
// assignment record the sessions tool stamps on each session's metadata at
// dispatch time (`orchestra:mcp-assignment`, stamped by core; this module only
// reads it). Global connection state comes from the location's MCP server
// list and is used ONLY to say whether an assigned server is currently
// usable — a connected server is never shown as assigned on that basis.
//
// Kept concepts, always distinct:
// - assigned: named in the session's assignment record;
// - allowed by role: the record inherited the role ceiling (explicit: false);
// - connected globally: the location's live status for that server;
// - required by a stage: not represented here at all — a stage requirement
//   is a plan, not a grant, and is never displayed as an assignment.

export const MCP_ASSIGNMENT_METADATA_KEY = "orchestra:mcp-assignment"

export interface McpAssignment {
  /** Server names granted to the session's current task, or "all" when the role sets no boundary. */
  readonly servers: readonly string[] | "all"
  /** Total MCP tool calls the task may make under this assignment. */
  readonly maxCalls: number
  /** Per-server call caps. */
  readonly perServer: Readonly<Record<string, number>>
  /** True when the Orchestrator passed an explicit grant; false when inherited from the role ceiling. */
  readonly explicit: boolean
  /** Budget epoch of the enforced limit, or null for an inherited assignment. */
  readonly budgetEpoch: string | null
  /** When the assignment was stamped (epoch milliseconds). */
  readonly assignedAt: number
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** The session's assignment record from its metadata; undefined when no task was ever dispatched to it. */
export function assignmentOf(metadata: unknown): McpAssignment | undefined {
  if (!isRecord(metadata)) return undefined
  const raw = metadata[MCP_ASSIGNMENT_METADATA_KEY]
  if (!isRecord(raw)) return undefined
  const servers =
    raw.servers === "all"
      ? "all"
      : Array.isArray(raw.servers) && raw.servers.every((item) => typeof item === "string")
        ? (raw.servers as string[])
        : undefined
  if (servers === undefined) return undefined
  if (typeof raw.maxCalls !== "number" || !Number.isInteger(raw.maxCalls) || raw.maxCalls < 0) return undefined
  if (typeof raw.assignedAt !== "number") return undefined
  const perServer: Record<string, number> = {}
  if (raw.perServer !== undefined) {
    if (!isRecord(raw.perServer)) return undefined
    for (const [server, cap] of Object.entries(raw.perServer)) {
      if (typeof cap !== "number" || !Number.isInteger(cap) || cap < 0) return undefined
      perServer[server] = cap
    }
  }
  return {
    servers,
    maxCalls: raw.maxCalls,
    perServer,
    explicit: raw.explicit === true,
    budgetEpoch: typeof raw.budgetEpoch === "string" ? raw.budgetEpoch : null,
    assignedAt: raw.assignedAt,
  }
}

export interface GlobalServer {
  readonly name: string
  /** Live connection status: connected | pending | disabled | failed | needs_auth. */
  readonly status: string
}

export interface AssignedRow {
  readonly name: string
  /** The server's live global status, or "unknown" when the location does not list it at all. */
  readonly status: string
  /** Usable by this session right now: assigned AND connected globally. */
  readonly usable: boolean
}

export type SessionMcpView =
  | { readonly kind: "unassigned" }
  | { readonly kind: "none"; readonly explicit: boolean; readonly assignedAt: number }
  | {
      readonly kind: "assigned"
      readonly explicit: boolean
      readonly assignedAt: number
      /** True when the grant is the role's unbounded ceiling ("all"). */
      readonly unrestricted: boolean
      readonly rows: readonly AssignedRow[]
      readonly assigned: number
      readonly usable: number
      readonly unavailable: number
    }

/** What the sidebar shows for one session: its assignment joined with live connection state. */
export function sessionMcpView(assignment: McpAssignment | undefined, global: readonly GlobalServer[]): SessionMcpView {
  if (!assignment) return { kind: "unassigned" }
  if (Array.isArray(assignment.servers) && assignment.servers.length === 0)
    return { kind: "none", explicit: assignment.explicit, assignedAt: assignment.assignedAt }
  const byName = new Map(global.map((server) => [server.name, server.status]))
  const names = assignment.servers === "all" ? global.map((server) => server.name) : [...assignment.servers]
  const rows = names.map((name) => {
    const status = byName.get(name) ?? "unknown"
    return { name, status, usable: status === "connected" }
  })
  const usable = rows.filter((row) => row.usable).length
  return {
    kind: "assigned",
    explicit: assignment.explicit,
    assignedAt: assignment.assignedAt,
    unrestricted: assignment.servers === "all",
    rows,
    assigned: rows.length,
    usable,
    unavailable: rows.length - usable,
  }
}

/** The one-line summary for a session's MCP section header. */
export function assignmentSummary(view: SessionMcpView): string {
  if (view.kind === "unassigned") return "Not assigned yet"
  if (view.kind === "none") return "No MCP assigned"
  if (view.unrestricted) return `All permitted · ${view.usable} usable`
  return view.unavailable > 0
    ? `${view.assigned} assigned · ${view.unavailable} unavailable`
    : `${view.assigned} assigned · ${view.usable} usable`
}

export interface TeamSessionLike {
  readonly id: string
  readonly title?: string
  readonly agent?: string
  readonly metadata?: unknown
}

export interface TeamWorkerMcp {
  readonly sessionID: string
  readonly title: string
  readonly agent: string
  readonly view: SessionMcpView
}

/**
 * Per-worker MCP assignments for one project: every session except the one
 * being viewed, each with its OWN assignment — never merged into one list.
 * Callers pass only the current project's sessions (from the project's own
 * session list), so assignments never leak across project boundaries.
 */
export function teamMcpView(
  sessions: readonly TeamSessionLike[],
  selfID: string,
  global: readonly GlobalServer[],
): TeamWorkerMcp[] {
  return sessions
    .filter((session) => session.id !== selfID)
    .map((session) => ({
      sessionID: session.id,
      title: session.title ?? session.id,
      agent: session.agent ?? "",
      view: sessionMcpView(assignmentOf(session.metadata), global),
    }))
}

/** Compact per-worker line for the collapsed team summary: "Researcher · 2 MCP". */
export function teamWorkerLine(worker: TeamWorkerMcp): string {
  if (worker.view.kind === "unassigned") return `${worker.title} · not assigned`
  if (worker.view.kind === "none") return `${worker.title} · 0 MCP`
  return `${worker.title} · ${worker.view.assigned} MCP`
}
