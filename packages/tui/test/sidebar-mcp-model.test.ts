import { describe, expect, test } from "bun:test"
import {
  assignmentOf,
  assignmentSummary,
  sessionMcpView,
  teamMcpView,
  teamWorkerLine,
  MCP_ASSIGNMENT_METADATA_KEY,
} from "../src/feature-plugins/sidebar/mcp-model"

// Session MCP visibility: the sidebar shows the assignment record stamped on
// each session, joined with live connection state. Global connection state
// alone never makes a server "assigned".

const global = [
  { name: "context7", status: "connected" },
  { name: "deepwiki", status: "connected" },
  { name: "playwright", status: "connected" },
  { name: "github", status: "needs_auth" },
  { name: "broken", status: "failed" },
]

const metadata = (assignment: unknown) => ({ [MCP_ASSIGNMENT_METADATA_KEY]: assignment })

describe("this session", () => {
  test("no record means not assigned yet — even with servers connected globally", () => {
    const view = sessionMcpView(assignmentOf({}), global)
    expect(view.kind).toBe("unassigned")
    expect(assignmentSummary(view)).toBe("Not assigned yet")
  })

  test("an empty assignment displays as no MCP assigned", () => {
    const view = sessionMcpView(
      assignmentOf(metadata({ servers: [], maxCalls: 0, perServer: {}, explicit: true, budgetEpoch: "e1", assignedAt: 1 })),
      global,
    )
    expect(view.kind).toBe("none")
    expect(assignmentSummary(view)).toBe("No MCP assigned")
  })

  test("assigned servers show their real connection state, distinct from assignment", () => {
    const view = sessionMcpView(
      assignmentOf(
        metadata({ servers: ["playwright", "github"], maxCalls: 12, perServer: {}, explicit: true, budgetEpoch: "e2", assignedAt: 2 }),
      ),
      global,
    )
    expect(view.kind).toBe("assigned")
    if (view.kind !== "assigned") return
    expect(view.rows).toEqual([
      { name: "playwright", status: "connected", usable: true },
      { name: "github", status: "needs_auth", usable: false },
    ])
    expect(assignmentSummary(view)).toBe("2 assigned · 1 unavailable · ≤12 calls")
  })

  test("a globally connected server that was not assigned is not shown as assigned", () => {
    const view = sessionMcpView(
      assignmentOf(metadata({ servers: ["context7"], maxCalls: 12, perServer: {}, explicit: true, budgetEpoch: "e3", assignedAt: 3 })),
      global,
    )
    if (view.kind !== "assigned") throw new Error("expected assigned view")
    expect(view.rows.map((row) => row.name)).toEqual(["context7"])
    expect(assignmentSummary(view)).toBe("1 assigned · 1 usable · ≤12 calls")
  })

  test("an assigned server missing from the global list is not connected, not usable", () => {
    const view = sessionMcpView(
      assignmentOf(metadata({ servers: ["gone"], maxCalls: 1, perServer: {}, explicit: true, budgetEpoch: "e4", assignedAt: 4 })),
      global,
    )
    if (view.kind !== "assigned") throw new Error("expected assigned view")
    expect(view.rows[0]).toEqual({ name: "gone", status: "unknown", usable: false })
  })

  test("stage requirements are not assignments: no record, no assignment shown", () => {
    // A stage may require playwright; until a dispatch stamps the session,
    // the view stays unassigned.
    const view = sessionMcpView(assignmentOf({ "orchestra:stage-hint": "playwright" }), global)
    expect(view.kind).toBe("unassigned")
  })
})

describe("team assignments", () => {
  const sessions = [
    { id: "main", title: "Orchestrator", agent: "orchestrator", metadata: {} },
    {
      id: "w1",
      title: "Researcher",
      agent: "team-researcher",
      metadata: metadata({ servers: ["context7", "deepwiki"], maxCalls: 12, perServer: {}, explicit: true, budgetEpoch: "a", assignedAt: 1 }),
    },
    {
      id: "w2",
      title: "Tester",
      agent: "team-tester",
      metadata: metadata({ servers: ["playwright"], maxCalls: 12, perServer: {}, explicit: true, budgetEpoch: "b", assignedAt: 2 }),
    },
    {
      id: "w3",
      title: "Writer",
      agent: "team-writer",
      metadata: metadata({ servers: [], maxCalls: 0, perServer: {}, explicit: true, budgetEpoch: "c", assignedAt: 3 }),
    },
    { id: "w4", title: "Idle", agent: "team-developer", metadata: {} },
  ]

  test("workers keep separate assignment lists and the viewed session is excluded", () => {
    const team = teamMcpView(sessions, "main", global)
    expect(team.map((worker) => worker.sessionID)).toEqual(["w1", "w2", "w3", "w4"])
    expect(teamWorkerLine(team[0]!)).toBe("Researcher · 2 MCP · ≤12 calls")
    expect(teamWorkerLine(team[1]!)).toBe("Tester · 1 MCP · ≤12 calls")
    expect(teamWorkerLine(team[2]!)).toBe("Writer · 0 MCP")
    expect(teamWorkerLine(team[3]!)).toBe("Idle · not assigned")
    if (team[0]?.view.kind !== "assigned") throw new Error("expected assigned view")
    expect(team[0].view.rows.map((row) => row.name)).toEqual(["context7", "deepwiki"])
  })

  test("a worker's own view shows only its own assignment", () => {
    const view = sessionMcpView(assignmentOf(sessions[2]!.metadata), global)
    if (view.kind !== "assigned") throw new Error("expected assigned view")
    expect(view.rows.map((row) => row.name)).toEqual(["playwright"])
  })
})
