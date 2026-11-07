import { describe, expect, test } from "bun:test"
import { Orchestra } from "@orchestra/schema/orchestra"
import { all as catalog } from "../src/mcp/catalog"
import { all, allows, forAgent, forRole, fromRole, missingRequired, serversOf } from "../src/mcp/role-profiles"

describe("MCP role profiles", () => {
  test("covers every built-in team role exactly once", () => {
    const ids = all.filter((profile) => profile.kind === "team-role").map((profile) => profile.id)
    expect(ids.toSorted()).toEqual(Orchestra.roles.map((role) => role.id).toSorted())
    for (const role of Orchestra.roles) expect(forRole(role.id)?.agent).toBe(String(Orchestra.role(role.id)))
  })

  test("derives a role's servers from its tool list, implied tools included", () => {
    const developer = forRole("developer")!
    for (const server of ["context7", "deepwiki", "github", "rea-anything", "serena", "playwright", "agent-desktop"])
      expect(allows(developer, server)).toBe(true)
    // The tester may edit test files but its profile still comes from the same derivation.
    expect(serversOf(["webfetch"])).toEqual(["context7", "deepwiki"])
    expect(serversOf(["read"])).toContain("serena")
    // `mcp_*` is the management toolset, not a server; bare actions name no server.
    expect(serversOf(["mcp_*", "mcp_forge", "read"])).toEqual(["serena", "xerj"])
  })

  test("servers a role's own rules name are required, the rest allowed", () => {
    const deep = forRole("deep-researcher")!
    const access = new Map(deep.servers.map((grant) => [grant.server, grant.access]))
    expect(access.get("context7")).toBe("required")
    expect(access.get("deepwiki")).toBe("required")
    expect(access.get("playwright")).toBe("required")
    expect(access.get("rea-anything")).toBe("required")
    // Its rules send it to github for issues and commits, so that is required too;
    // serena only rides along with the read tools and stays allowed.
    expect(access.get("github")).toBe("required")
    expect(access.get("serena")).toBe("allowed")

    const auditor = forRole("security-auditor")!
    expect(auditor.servers.find((grant) => grant.server === "rea-anything")?.access).toBe("required")

    const writer = forRole("writer")!
    expect(allows(writer, "rea-anything")).toBe(false)
    expect(allows(writer, "context7")).toBe(true)
  })

  test("read-only and narrow roles stay narrow", () => {
    const counterexample = forRole("counterexample-engineer")!
    expect(allows(counterexample, "playwright")).toBe(false)
    expect(allows(counterexample, "rea-anything")).toBe(false)
    expect(allows(counterexample, "context7")).toBe(true)

    const analyst = forRole("product-analyst")!
    expect(allows(analyst, "playwright")).toBe(false)
    expect(allows(analyst, "agent-desktop")).toBe(false)
  })

  test("no profile grants a server that does not exist: android_helper is gone from every ceiling", () => {
    for (const profile of all)
      for (const grant of profile.servers) expect(grant.server).not.toBe("android_helper")
    expect(catalog.some((entry) => entry.id === "android_helper")).toBe(false)
    expect(allows(forRole("mobile-developer")!, "android_helper")).toBe(false)
    expect(allows(forRole("tester")!, "android_helper")).toBe(false)
  })

  test("every granted server is a catalog server", () => {
    const known = new Set(catalog.map((entry) => entry.id))
    for (const profile of all)
      for (const grant of profile.servers) expect(known.has(grant.server)).toBe(true)
  })

  test("every catalog server is allowed for at least one team role", () => {
    for (const entry of catalog)
      expect(all.some((profile) => profile.kind === "team-role" && allows(profile, entry.id))).toBe(true)
  })

  test("standalone agents match the access their permission rules leave them", () => {
    const orchestrator = forAgent("orchestrator")!
    expect(orchestrator.unrestricted).toBe(true)
    expect(orchestrator.servers).toEqual([])
    expect(missingRequired(orchestrator, [])).toEqual([])

    const president = forAgent("president")!
    expect(president.servers).toEqual([])
    expect(allows(president, "context7")).toBe(false)

    const explore = forAgent("explore")!
    expect(allows(explore, "context7")).toBe(true)
    expect(allows(explore, "deepwiki")).toBe(true)
    expect(allows(explore, "playwright")).toBe(false)

    for (const id of ["notes", "title", "summary", "compaction"]) {
      const profile = forAgent(id)!
      expect(profile.servers).toEqual([])
      expect(allows(profile, "context7")).toBe(false)
    }
    expect(forAgent("no-such-agent")).toBeUndefined()
  })

  test("team sessions resolve through their team- agent id", () => {
    expect(forAgent("team-reviewer")?.id).toBe("reviewer")
    expect(forAgent(String(Orchestra.role("developer")))?.id).toBe("developer")
  })

  test("a custom role gets a profile from its spec alone, with no extra setup", () => {
    const profile = fromRole({
      id: "docs-scout",
      name: "Docs Scout",
      description: "Reads documentation only.",
      rules: "Answer from context7 docs only.",
      category: "Planning",
      readOnly: true,
      tools: ["read", "context7_*"],
    })
    expect(profile.agent).toBe("team-docs-scout")
    expect(profile.servers).toEqual([
      { server: "context7", access: "required" },
      { server: "serena", access: "allowed" },
      { server: "xerj", access: "allowed" },
    ])
    // A role with no tool list inherits its kind's toolkit (RoleToolkits),
    // not the whole catalog: the "General" kind gets the generalist floor,
    // which still leaves production-error servers such as sentry outside.
    const open = fromRole({
      id: "open",
      name: "Open",
      description: "",
      rules: "",
      category: "General",
      readOnly: false,
    })
    expect(open.unrestricted).toBe(false)
    expect(allows(open, "sentry")).toBe(false)
    expect(allows(open, "context7")).toBe(true)
  })

  test("missingRequired reports only required servers that are absent", () => {
    const deep = forRole("deep-researcher")!
    const missing = missingRequired(deep, catalog.map((entry) => entry.id))
    expect(missing).toEqual([])
    expect(missingRequired(deep, ["context7"])).toContain("rea-anything")
    expect(missingRequired(deep, ["context7"])).not.toContain("memory")
  })
})
