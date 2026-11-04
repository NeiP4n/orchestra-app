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
    for (const server of ["context7", "deepwiki", "git", "github", "sequential-thinking", "rea-anything", "memory", "filesystem"])
      expect(allows(developer, server)).toBe(true)
    // The tester may edit test files but its profile still comes from the same derivation.
    expect(serversOf(["webfetch"])).toEqual(["context7", "deepwiki", "fetch", "mcp-docs"])
    expect(serversOf(["read"])).toContain("filesystem")
    // `mcp_*` is the management toolset, not a server; bare actions name no server.
    expect(serversOf(["mcp_*", "mcp_forge", "read"])).toEqual(["filesystem"])
  })

  test("servers a role's own rules name are required, the rest allowed", () => {
    const deep = forRole("deep-researcher")!
    const access = new Map(deep.servers.map((grant) => [grant.server, grant.access]))
    expect(access.get("context7")).toBe("required")
    expect(access.get("deepwiki")).toBe("required")
    expect(access.get("mcp-docs")).toBe("required")
    expect(access.get("playwright")).toBe("required")
    expect(access.get("rea-anything")).toBe("required")
    // Its rules send it to git/github for issues and commits, so those are required too;
    // memory only rides along with the notes tools and stays allowed.
    expect(access.get("git")).toBe("required")
    expect(access.get("memory")).toBe("allowed")

    const auditor = forRole("security-auditor")!
    expect(auditor.servers.find((grant) => grant.server === "rea-anything")?.access).toBe("required")

    const writer = forRole("writer")!
    expect(allows(writer, "sequential-thinking")).toBe(false)
    expect(allows(writer, "context7")).toBe(true)
  })

  test("read-only and narrow roles stay narrow", () => {
    const counterexample = forRole("counterexample-engineer")!
    expect(allows(counterexample, "playwright")).toBe(false)
    expect(allows(counterexample, "rea-anything")).toBe(false)
    expect(allows(counterexample, "context7")).toBe(true)

    const analyst = forRole("product-analyst")!
    expect(allows(analyst, "playwright")).toBe(false)
    expect(allows(analyst, "desktop-commander")).toBe(false)
  })

  test("mobile roles get the android_helper server, which is not a catalog entry", () => {
    expect(allows(forRole("mobile-developer")!, "android_helper")).toBe(true)
    expect(allows(forRole("tester")!, "android_helper")).toBe(true)
    expect(allows(forRole("developer")!, "android_helper")).toBe(false)
    expect(catalog.some((entry) => entry.id === "android_helper")).toBe(false)
  })

  test("every granted server is a catalog server or a known external one", () => {
    const known = new Set([...catalog.map((entry) => entry.id), "android_helper"])
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
    expect(missingRequired(orchestrator, [])).toEqual(["sequential-thinking", "memory"])
    expect(missingRequired(orchestrator, ["sequential-thinking", "memory"])).toEqual([])

    const president = forAgent("president")!
    expect(president.servers).toEqual([])
    expect(allows(president, "context7")).toBe(false)

    const explore = forAgent("explore")!
    expect(allows(explore, "context7")).toBe(true)
    expect(allows(explore, "fetch")).toBe(true)
    expect(allows(explore, "playwright")).toBe(false)

    for (const id of ["notes", "title", "summary", "compaction"]) {
      const profile = forAgent(id)!
      expect(profile.servers).toEqual([])
      expect(allows(profile, "memory")).toBe(false)
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
      { server: "filesystem", access: "allowed" },
    ])
    // A role with no tool list is unrestricted by the role contract, and says so.
    const open = fromRole({
      id: "open",
      name: "Open",
      description: "",
      rules: "",
      category: "General",
      readOnly: false,
    })
    expect(open.unrestricted).toBe(true)
    expect(allows(open, "sentry")).toBe(true)
  })

  test("missingRequired reports only required servers that are absent", () => {
    const deep = forRole("deep-researcher")!
    const missing = missingRequired(deep, catalog.map((entry) => entry.id))
    expect(missing).toEqual([])
    expect(missingRequired(deep, ["context7"])).toContain("rea-anything")
    expect(missingRequired(deep, ["context7"])).not.toContain("memory")
  })
})
