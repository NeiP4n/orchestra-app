import { describe, expect, test } from "bun:test"
import { OrchestraTool } from "../src/tool/plugin/orchestra.js"

// Per-session MCP assignments: the record the sessions tool stamps on a
// session's metadata at every dispatch, and the sidebar reads back. The
// parser is the contract — a malformed or missing record means "not assigned
// yet", never "everything assigned".

const stamp = OrchestraTool.mcpAssignmentOf
const KEY = OrchestraTool.MCP_ASSIGNMENT_METADATA_KEY

describe("mcpAssignmentOf", () => {
  test("reads an explicit assignment with its budget epoch", () => {
    const assignment = stamp({
      [KEY]: {
        servers: ["context7", "deepwiki"],
        maxCalls: 12,
        perServer: { context7: 4 },
        explicit: true,
        budgetEpoch: "epoch-1",
        assignedAt: 1234,
      },
    })
    expect(assignment).toEqual({
      servers: ["context7", "deepwiki"],
      maxCalls: 12,
      perServer: { context7: 4 },
      explicit: true,
      budgetEpoch: "epoch-1",
      assignedAt: 1234,
    })
  })

  test("an explicit empty assignment is an assignment of no MCP", () => {
    const assignment = stamp({
      [KEY]: { servers: [], maxCalls: 0, perServer: {}, explicit: true, budgetEpoch: "epoch-2", assignedAt: 5 },
    })
    expect(assignment?.servers).toEqual([])
    expect(assignment?.explicit).toBe(true)
  })

  test("an inherited assignment records the role ceiling without an epoch", () => {
    const assignment = stamp({
      [KEY]: { servers: "all", maxCalls: 24, perServer: {}, explicit: false, budgetEpoch: null, assignedAt: 9 },
    })
    expect(assignment?.servers).toBe("all")
    expect(assignment?.explicit).toBe(false)
    expect(assignment?.budgetEpoch).toBeNull()
  })

  test("missing or malformed records mean not assigned yet", () => {
    expect(stamp(undefined)).toBeUndefined()
    expect(stamp({})).toBeUndefined()
    expect(stamp({ [KEY]: "everything" })).toBeUndefined()
    expect(stamp({ [KEY]: { servers: "context7", maxCalls: 1, assignedAt: 1 } })).toBeUndefined()
    expect(stamp({ [KEY]: { servers: [], maxCalls: -1, assignedAt: 1 } })).toBeUndefined()
    expect(stamp({ [KEY]: { servers: [], maxCalls: 0 } })).toBeUndefined()
    expect(stamp({ [KEY]: { servers: [42], maxCalls: 0, assignedAt: 1 } })).toBeUndefined()
  })

  test("the assignment key is distinct from the enforced limit key", () => {
    expect(KEY).toBe("orchestra:mcp-assignment")
    expect(KEY).not.toBe(OrchestraTool.MCP_LIMIT_METADATA_KEY)
  })

  test("the survey key is the stamp mcp_manager inspect writes and the dispatch gate reads", () => {
    expect(OrchestraTool.MCP_SURVEY_METADATA_KEY).toBe("orchestra:mcp-survey")
  })
})

describe("assignments never widen a role ceiling", () => {
  test("resolveMcpLimit still refuses servers outside the role's own list", () => {
    const role = { name: "Tester", tools: ["playwright_*"], readOnly: false }
    const refused = OrchestraTool.resolveMcpLimit(role, { servers: ["github"] })
    expect(refused.ok).toBe(false)
    const granted = OrchestraTool.resolveMcpLimit(role, { servers: [] })
    expect(granted.ok).toBe(true)
    if (granted.ok) {
      expect(granted.limit.servers).toEqual([])
      expect(granted.limit.maxCalls).toBe(0)
    }
  })
})

test("disabled MCP has no forced survey or zero-limit boilerplate",()=>{
 const previous=process.env.ORCHESTRA_MCP
 try{
  delete process.env.ORCHESTRA_MCP
  expect(OrchestraTool.dispatchGuide()).not.toContain("The assignment must come from a survey")
  expect(OrchestraTool.dispatchGuide()).not.toContain("MCP assignment is mandatory")
  expect(OrchestraTool.mcpBriefLine({servers:[],maxCalls:0})).toBe("")
  process.env.ORCHESTRA_MCP="1"
  expect(OrchestraTool.dispatchGuide()).toContain("The assignment must come from a survey")
 }finally{if(previous===undefined)delete process.env.ORCHESTRA_MCP;else process.env.ORCHESTRA_MCP=previous}
})

test("desktop dispatch preflight refuses Windows desktop work but not browser or unit tests",()=>{
 expect(OrchestraTool.desktopDispatchDenial({action:"send",text:"Run desktop verification"},"win32",{})).toContain("Do not assign desktop")
 expect(OrchestraTool.desktopDispatchDenial({action:"send",text:"Run unit tests and browser verification"},"win32",{})).toBeUndefined()
 expect(OrchestraTool.desktopDispatchDenial({action:"send",text:"Run desktop verification"},"linux",{})).toBeUndefined()
 expect(OrchestraTool.withoutDisabledMcpGuidance("Delegate now. A dispatch also needs a fresh MCP survey and an explicit mcp assignment: inspect first. Continue.",{})).toBe("Delegate now. Continue.")
})
