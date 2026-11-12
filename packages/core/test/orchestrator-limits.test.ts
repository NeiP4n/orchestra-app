import { describe, expect, test } from "bun:test"
import { OrchestraTool } from "../src/tool/plugin/orchestra.js"
import type { SessionMessage } from "../src/session/message.js"

const gate = OrchestraTool.delegationGate
const LIMIT = OrchestraTool.ORCHESTRATOR_MESSAGE_LIMIT

describe("the 6-message delegation gate", () => {
  test("counts each own message once, however many tools it calls", () => {
    let counted: ReadonlyArray<string> = []
    for (const id of ["m1", "m1", "m2", "m3"]) {
      const result = gate(counted, { tool: "read", messageID: id })
      expect(result.blocked).toBe(false)
      counted = result.counted
    }
    expect(counted).toEqual(["m1", "m2", "m3"])
  })

  test("blocks a new own message past the limit", () => {
    let counted: ReadonlyArray<string> = []
    for (let index = 1; index <= LIMIT; index++) {
      const result = gate(counted, { tool: "edit", messageID: `m${index}` })
      expect(result.blocked).toBe(false)
      counted = result.counted
    }
    const blocked = gate(counted, { tool: "edit", messageID: `m${LIMIT + 1}` })
    expect(blocked.blocked).toBe(true)
    expect(blocked.counted).toEqual(counted)
  })

  test("a delegation resets the count, management and questions never count", () => {
    const counted = Array.from({ length: LIMIT }, (_, index) => `m${index + 1}`)
    expect(gate(counted, { tool: "sessions", messageID: `m${LIMIT + 1}`, action: "list" })).toEqual({
      counted,
      blocked: false,
      reset: false,
    })
    expect(gate(counted, { tool: "question", messageID: `m${LIMIT + 1}` }).blocked).toBe(false)
    // A send without a task text is not a delegation.
    expect(gate(counted, { tool: "sessions", messageID: `m${LIMIT + 1}`, action: "send", text: "  " }).blocked).toBe(false)
    const reset = gate(counted, { tool: "sessions", messageID: `m${LIMIT + 1}`, action: "create", text: "Build the thing" })
    expect(reset).toEqual({ counted: [], blocked: false, reset: true })
  })

  test("the MCP survey is always allowed at the limit — otherwise dispatch could never happen", () => {
    // A dispatch is refused without a fresh survey, so refusing the survey
    // at the limit would deadlock the Orchestrator: it could neither survey
    // nor dispatch. Inspect is read-only, so it never counts and never resets.
    const counted = Array.from({ length: LIMIT }, (_, index) => `m${index + 1}`)
    expect(gate(counted, { tool: "mcp_manager", messageID: `m${LIMIT + 1}`, action: "inspect" })).toEqual({
      counted,
      blocked: false,
      reset: false,
    })
    // Only inspect is exempt: acquiring or installing a server still counts
    // as doing the work and stays gated past the limit.
    expect(gate(counted, { tool: "mcp_manager", messageID: `m${LIMIT + 1}`, action: "acquire" }).blocked).toBe(true)
    expect(gate(counted, { tool: "mcp_manager", messageID: `m${LIMIT + 1}` }).blocked).toBe(true)
  })

  test("the limit-reached text names the survey as the way out", () => {
    expect(OrchestraTool.delegationStatus(LIMIT).text).toContain("mcp_manager inspect")
  })
})

describe("own message streak from history", () => {
  const assistant = (...tools: Array<[string, Record<string, unknown>?]>) =>
    ({
      type: "assistant",
      content: tools.map(([name, input]) => ({ type: "tool", name, state: { status: "completed", input: input ?? {} } })),
    }) as never as SessionMessage.Info
  const user = { type: "user", text: "go" } as never as SessionMessage.Info

  test("counts assistant messages since the last incoming message", () => {
    expect(OrchestraTool.ownMessageStreak([user, assistant(["read"]), assistant(["edit"])])).toBe(2)
    expect(OrchestraTool.ownMessageStreak([assistant(["read"]), user, assistant(["read"])])).toBe(1)
  })

  test("a completed delegation in a message restarts the streak", () => {
    const messages = [
      user,
      assistant(["read"]),
      assistant(["sessions", { action: "send", text: "Do it" }]),
      assistant(["read"]),
    ]
    expect(OrchestraTool.ownMessageStreak(messages)).toBe(1)
    expect(OrchestraTool.delegationStatus(1).mustDelegate).toBe(false)
    expect(OrchestraTool.delegationStatus(LIMIT).mustDelegate).toBe(true)
    expect(OrchestraTool.delegationStatus(LIMIT).text).toContain("limit reached")
  })
})

describe("MCP limits the Orchestrator distributes", () => {
  const role = { name: "Developer", tools: ["read", "edit", "context7_*", "playwright_*"], readOnly: false }

  test("a role's ceiling comes from its own tool list", () => {
    // withImplied expands the list first: `read` implies the serena and xerj MCP servers.
    expect(OrchestraTool.mcpServersOf(role)).toEqual(["context7", "playwright", "serena", "xerj"])
    expect(OrchestraTool.mcpServersOf({ tools: ["mcp_*"] })).toBe("all")
    expect(OrchestraTool.mcpServersOf({})).toBe("all")
    expect(OrchestraTool.defaultMcpLimit(role)).toEqual({
      servers: ["context7", "playwright", "serena", "xerj"],
      maxCalls: 24,
      perServer: {},
    })
    expect(OrchestraTool.defaultMcpLimit({ ...role, readOnly: true }).maxCalls).toBe(12)
    expect(OrchestraTool.defaultMcpLimit({ tools: [] }).maxCalls).toBe(0)
  })

  test("the Orchestrator may tighten but never widen the ceiling", () => {
    const tightened = OrchestraTool.resolveMcpLimit(role, { servers: ["context7"], maxCalls: 5, perServer: { context7: 3 } })
    expect(tightened).toEqual({ ok: true, limit: { servers: ["context7"], maxCalls: 5, perServer: { context7: 3 } } })
    const widenedServer = OrchestraTool.resolveMcpLimit(role, { servers: ["context7", "github"] })
    expect(widenedServer.ok).toBe(false)
    if (!widenedServer.ok) expect(widenedServer.message).toContain("github")
    const widenedCalls = OrchestraTool.resolveMcpLimit(role, { maxCalls: 25 })
    expect(widenedCalls.ok).toBe(false)
    const badPerServer = OrchestraTool.resolveMcpLimit(role, { maxCalls: 4, perServer: { context7: 9 } })
    expect(badPerServer.ok).toBe(false)
    const emptyWithCalls = OrchestraTool.resolveMcpLimit(role, { servers: [], maxCalls: 3 })
    expect(emptyWithCalls.ok).toBe(false)
    const forbidden = OrchestraTool.resolveMcpLimit(role, { servers: [] })
    expect(forbidden).toEqual({ ok: true, limit: { servers: [], maxCalls: 0, perServer: {} } })
  })

  test("deny rules close every known server outside the allowlist", () => {
    const limit = { servers: ["context7"], maxCalls: 5, perServer: {} }
    expect(OrchestraTool.mcpDenyRules(limit, ["context7", "playwright", "github"])).toEqual([
      { action: "github_*", resource: "*", effect: "deny" },
      { action: "playwright_*", resource: "*", effect: "deny" },
    ])
    expect(OrchestraTool.mcpDenyRules({ servers: "all", maxCalls: 5, perServer: {} }, ["github"])).toEqual([])
    expect(OrchestraTool.mcpBriefLine(limit)).toContain("at most 5 MCP tool call(s)")
    expect(OrchestraTool.mcpBriefLine(limit)).toContain("context7")
  })
})

describe("reading the Browser tab at the limit", () => {
  test("looking is never refused, acting in the page is", () => {
    const full = Array.from({ length: OrchestraTool.ORCHESTRATOR_MESSAGE_LIMIT }, (_, index) => `m${index}`)
    for (const action of ["sessions", "info", "text", "screenshot"])
      expect(gate(full, { tool: "browser", messageID: "next", action }).blocked).toBe(false)
    expect(gate(full, { tool: "browser", messageID: "next", action: "click" }).blocked).toBe(true)
  })
})


test("zero MCP brief and rejected positive budget distinguish native browser without granting permission", () => {
  const role = {name:"BrowserAgent",tools:["read","browser"],readOnly:true}
  const allowed = OrchestraTool.resolveMcpLimit(role, {servers:[],maxCalls:0})
  expect(allowed.ok).toBe(true)
  if (!allowed.ok) throw Error("zero assignment refused")
  const brief = OrchestraTool.mcpBriefLine(allowed.limit)
  expect(brief).toContain("at most 0 MCP tool call(s)")
  expect(brief).toContain("Built-in tools including browser are unaffected by this MCP budget")
  expect(brief).toContain("role, mode, permissions and safety checks still apply")
  expect(OrchestraTool.mcpDenyRules(allowed.limit,["playwright"])).toEqual([{action:"playwright_*",resource:"*",effect:"deny"}])
  const rejected = OrchestraTool.resolveMcpLimit(role,{servers:[],maxCalls:10})
  expect(rejected.ok).toBe(false)
  if(rejected.ok) throw Error("invalid assignment allowed")
  expect(rejected.message).toContain("Nothing was sent")
  expect(rejected.message).toContain("not built-in tools such as browser")
})
