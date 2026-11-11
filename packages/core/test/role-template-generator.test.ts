import { describe, expect, test } from "bun:test"
import { Orchestra } from "@orchestra/schema/orchestra"
import { RoleTemplateGenerator } from "@orchestra/core/roles/generator"

describe("RoleTemplateGenerator", () => {
  test("every signal names only shipped roles", () => {
    const ids = new Set(Orchestra.roles.map((role) => role.id))
    for (const task of [
      "fix the security hole in the login api",
      "new landing page and ui polish",
      "migrate the postgres schema and deploy",
      "android app crash on start",
      "research and compare vector stores, write docs",
    ])
      for (const id of RoleTemplateGenerator.pick(task)) expect(ids.has(id)).toBe(true)
  })

  test("a task picks the roles its words imply, with a builder and a checker", () => {
    const picked = RoleTemplateGenerator.pick("fix the security hole in the login api")
    expect(picked).toContain("security-auditor")
    expect(picked).toContain("backend-developer")
    expect(picked).toContain("developer")
    expect(picked).toContain("reviewer")
  })

  test("a vague task still gets a builder and a checker, and no more than six roles", () => {
    expect(RoleTemplateGenerator.pick("do the thing")).toEqual(["developer", "reviewer"])
    const wide = RoleTemplateGenerator.pick(
      "security ui api database android desktop deploy performance research docs bug test review design",
    )
    expect(wide.length).toBeLessThanOrEqual(6)
    expect(new Set(wide).size).toBe(wide.length)
  })

  test("generate returns a template with a playbook and each role's own toolkit", () => {
    const template = RoleTemplateGenerator.generate("review the api for security issues", "Api review")
    expect(template.name).toBe("Api review")
    expect(template.roles).toEqual(template.members.map((member) => String(member.agent).replace(/^team-/, "")))
    expect(template.playbook).toContain("Recommended roles")
    for (const entry of template.toolkits) expect(entry.tools.length).toBeGreaterThan(0)
    // Read-only roles stay read-only: the reviewer's toolkit has no edit tools.
    const reviewer = template.toolkits.find((entry) => entry.role === "reviewer")
    expect(reviewer?.tools).not.toContain("edit")
  })

  test("an empty task is refused", () => {
    expect(() => RoleTemplateGenerator.generate("   ")).toThrow()
  })
})
