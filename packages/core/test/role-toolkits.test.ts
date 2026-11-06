import { describe, expect, test } from "bun:test"
import { RoleToolkits } from "@orchestra/core/roles/toolkits"

const role = (id: string, name: string, category = "Team", tools?: string[]) => ({
  id,
  name,
  category,
  ...(tools ? { tools } : {}),
})

describe("RoleToolkits.kindOfRole", () => {
  test("the seven kinds classify by id, name and category", () => {
    expect(RoleToolkits.kindOfRole(role("strategic-planner", "Strategic Systems Planner", "Planning"))).toBe("orchestrator")
    expect(RoleToolkits.kindOfRole(role("probe-runner", "Probe Runner", "Quality"))).toBe("tester")
    expect(RoleToolkits.kindOfRole(role("deep-researcher", "Deep Researcher", "Data"))).toBe("scout")
    expect(RoleToolkits.kindOfRole(role("architect", "Architect", "Planning"))).toBe("architect")
    expect(RoleToolkits.kindOfRole(role("developer", "Developer", "Build"))).toBe("coder")
    expect(RoleToolkits.kindOfRole(role("security-auditor", "Security Auditor", "Quality"))).toBe("reviewer")
    expect(RoleToolkits.kindOfRole(role("release-manager", "Release Manager", "Operations"))).toBe("releaser")
    expect(RoleToolkits.kindOfRole(role("something-new", "Something New", "Team"))).toBe("general")
  })
})

describe("RoleToolkits.effectiveTools", () => {
  test("an explicit list wins over the kind default", () => {
    const tools = RoleToolkits.effectiveTools(role("probe-runner", "Probe Runner", "Quality", ["read", "shell"]))
    expect(tools).toEqual(["read", "shell"])
  })

  test("a role without a list inherits its kind's toolkit, never everything", () => {
    // Probe Runner is the Б14 case: a planner-invented role with no saved
    // list. It gets the tester toolkit (probe + browser + desktop), not the
    // whole catalog — and it does NOT get the orchestration tools: a probe
    // dispatches nothing, it only runs and reports.
    const tools = RoleToolkits.effectiveTools(role("probe-runner", "Probe Runner", "Quality"))
    expect(tools).toBeDefined()
    expect(tools).toContain("shell")
    expect(tools).toContain("playtest")
    expect(tools).not.toContain("sessions")
    expect(tools).not.toContain("federation")
    // The orchestrator kind plans and delegates; it never edits files.
    const planner = RoleToolkits.effectiveTools(role("planner-2", "Planner", "Planning"))
    expect(planner).not.toContain("edit")
    expect(planner).toContain("read")
  })

  test("no role means no ceiling, as before", () => {
    expect(RoleToolkits.effectiveTools(undefined)).toBeUndefined()
  })
})

describe("RoleToolkits.auditTools", () => {
  test("tools inside the toolkit pass, tools outside are named with a reason", () => {
    const audit = RoleToolkits.auditTools(role("probe-runner", "Probe Runner", "Quality"), [
      "read",
      "shell",
      "sessions",
      "society_forge",
    ])
    expect(audit.allowed).toEqual(["read", "shell"])
    expect(audit.outside.map((entry) => entry.tool)).toEqual(["sessions", "society_forge"])
    for (const entry of audit.outside) expect(entry.reason.length).toBeGreaterThan(0)
  })

  test("tools \"all\" is outside every toolkit", () => {
    const audit = RoleToolkits.auditTools(role("developer", "Developer", "Build"), ["all"])
    expect(audit.allowed).toEqual([])
    expect(audit.outside).toHaveLength(1)
  })

  test("MCP patterns match by prefix: context7_* covers a context7 tool", () => {
    const audit = RoleToolkits.auditTools(role("researcher-2", "Researcher", "Data"), [
      "context7_resolve-library-id",
      "sentry_get-issue",
    ])
    expect(audit.allowed).toContain("context7_resolve-library-id")
    expect(audit.outside.map((entry) => entry.tool)).toEqual(["sentry_get-issue"])
  })
})
