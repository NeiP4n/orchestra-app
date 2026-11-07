import { describe, expect, test } from "bun:test"
import { contains, legacyTemplates, playbookOf, roles, templateByID, templates } from "../src/orchestra.js"

describe("Orchestra.contains directory matching", () => {
  test("handles case-insensitive Windows drive paths", () => {
    expect(contains("C:/Proj", "c:/proj/sub")).toBe(true)
    expect(contains("c:/proj", "C:/Proj/sub")).toBe(true)
    expect(contains("C:\\Proj", "c:/proj/sub")).toBe(true)
    expect(contains("C:/PROJ", "c:/proj")).toBe(true)
  })

  test("handles case-insensitive UNC network paths", () => {
    expect(contains("//Server/Share/Proj", "//server/share/proj/sub")).toBe(true)
    expect(contains("//srv/share", "//SRV/SHARE/sub")).toBe(true)
    expect(contains("//srv/share1", "//srv/share2/sub")).toBe(false)
  })

  test("collapses .. and prevents path traversal escapes", () => {
    expect(contains("C:/Proj", "C:/Proj/../evil")).toBe(false)
    expect(contains("C:/Proj", "C:/Proj/sub/../sub/file.txt")).toBe(true)
    expect(contains("/home/user/proj", "/home/user/proj/../evil")).toBe(false)
  })

  test("handles standard Unix paths", () => {
    expect(contains("/home/user/proj", "/home/user/proj/sub")).toBe(true)
    expect(contains("/home/user/proj", "/home/user/proj")).toBe(true)
    expect(contains("/home/user/proj", "/home/user/other")).toBe(false)
  })
})

// Dynamic workflow templates: a built-in template describes a type of work.
// Its roles are recommendations; nothing in a built-in fixes a team size or a
// stage count. Removed built-ins survive only as legacy compatibility records.

const REMOVED_TEMPLATES = ["full", "factory", "pro-engineers", "proof-driven"]
const KEPT_TEMPLATES = [
  "quick",
  "feature",
  "system",
  "bugfix",
  "ui",
  "web-app",
  "mobile-app",
  "desktop-app",
  "research",
  "docs",
  "security-audit",
  "deep-audit",
  "strategic-planning",
  "release",
  "opencode-core",
  "game-prototype",
  "marketing-launch",
  "team-solve",
]

describe("built-in templates", () => {
  test("removed built-ins no longer appear in the normal template list", () => {
    for (const id of REMOVED_TEMPLATES) expect(templates.find((item) => item.id === id)).toBeUndefined()
  })

  test("the specialized templates remain, each with role recommendations", () => {
    expect(templates.map((item) => item.id).toSorted()).toEqual([...KEPT_TEMPLATES].toSorted())
    for (const template of templates) {
      expect(template.roles?.length ?? 0).toBeGreaterThan(0)
    }
  })

  test("every recommended role and every member resolves to a registered role", () => {
    const ids = new Set(roles.map((item) => item.id))
    for (const template of [...templates, ...legacyTemplates]) {
      for (const id of template.roles ?? []) expect(ids.has(id)).toBe(true)
      for (const member of template.members) expect(ids.has(member.agent.replace(/^team-/, ""))).toBe(true)
    }
  })

  test("no built-in playbook prescribes a fixed stage count or a mandatory roster", () => {
    for (const template of templates) {
      if (template.id === "team-solve") continue
      const playbook = template.playbook ?? ""
      expect(playbook).not.toMatch(/\bPhase \d/)
      expect(playbook).not.toMatch(/\d+-stage\b/)
      expect(playbook.toLowerCase()).not.toContain("always create")
      expect(playbook.toLowerCase()).not.toContain("full factory")
      expect(playbook.toLowerCase()).not.toContain("deploy the full")
    }
  })

  test("team-solve is the one fixed-roster method preset: six roles, in pipeline order", () => {
    const preset = templates.find((item) => item.id === "team-solve")
    expect(preset).toBeDefined()
    expect(preset?.roles).toEqual([
      "team-planner",
      "ideator-a",
      "ideator-b",
      "team-solver",
      "team-manager",
      "repairer",
    ])
    expect(preset?.members.map((member) => member.agent.replace(/^team-/, ""))).toEqual(preset?.roles)
    for (const id of preset?.roles ?? []) {
      const role = roles.find((item) => item.id === id)
      expect(role).toBeDefined()
      expect(role?.rules).toContain("Fresh context")
      expect(role?.rules).toContain("Mission:")
    }
  })

  test("team-solve playbook: files only, fresh contexts, test verdict, one repair round", () => {
    const playbook = templates.find((item) => item.id === "team-solve")?.playbook ?? ""
    expect(playbook).toContain("fresh session")
    expect(playbook).toContain("no shared chat")
    expect(playbook).toContain(".orchestra/team-notes.md")
    expect(playbook).toContain("dod verify")
    expect(playbook).toContain("never by a vote")
    expect(playbook).toContain("at most one round")
    expect(playbook).toContain("exit code is the verdict")
  })
})

describe("legacy template compatibility", () => {
  test("removed built-ins are preserved as legacy records with their playbooks", () => {
    expect(legacyTemplates.map((item) => item.id).toSorted()).toEqual([...REMOVED_TEMPLATES].toSorted())
    for (const legacy of legacyTemplates) {
      expect(legacy.playbook?.length ?? 0).toBeGreaterThan(80)
      expect(legacy.members.length).toBeGreaterThan(0)
    }
  })

  test("templateByID prefers a live template and falls back to the legacy record", () => {
    const live = [{ id: "factory", name: "Mine", description: "", members: [], playbook: "My own factory." }]
    expect(templateByID("factory", live)?.name).toBe("Mine")
    expect(templateByID("factory", [])?.name).toBe("Software Factory")
    expect(templateByID("feature", [])).toBeUndefined()
    expect(templateByID("nope", [])).toBeUndefined()
  })

  test("playbookOf resolves a removed id's playbook for historical projects", () => {
    expect(playbookOf({ id: "proof-driven" })).toContain("acceptance matrix")
    expect(playbookOf({ id: "feature" })).toBe(templates.find((item) => item.id === "feature")?.playbook)
    expect(playbookOf({ id: "nope" })).toBeUndefined()
  })
})
