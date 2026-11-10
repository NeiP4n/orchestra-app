import { expect, test } from "bun:test"
import { ProjectTemplateV2Plan as Plan } from "../src/project-template-v2-plan"
import { ProjectTemplateV2 as V2 } from "../src/project-template-v2"
import { processFixture } from "./project-template-v2.test"
function setup() {
  const b = processFixture(), preview = V2.preview(JSON.stringify(b)); if (!preview.ok) throw Error(preview.error)
  const d: Plan.Destination = {
    projectID: "prj_new", installedVersion: "1.0.0", reviewedDigest: preview.value.digest,
    roles: [structuredClone(b.process.roles[0])], skills: [], models: new Set(["demo/free", "demo/free#careful", "demo/backup", "demo/backup#careful"]),
    programs: new Set(["git"]), mcp: new Map([["docs", { disabled: true }]]), providers: new Set(["demo"]),
  }
  return { b, d, text: preview.value.text }
}
test("project-local proposal never replaces a global role or skill and remaps every reference", () => {
  const { b, d, text } = setup()
  const oldRole = { ...b.process.roles[1], rules: "Different global rules" }, oldSkill = { ...b.process.skills[0], description: "Different global skill" }
  d.roles = [...d.roles, oldRole]; d.skills = [oldSkill]
  const before = structuredClone({ roles: d.roles, skills: d.skills, mcp: d.mcp })
  const p = Plan.prepare(text, d)
  expect(p.roles[0].action).toBe("reuse-core")
  expect(p.roles[1].existing).toBe("different")
  expect(p.roles[1].action).toBe("install-project-local")
  expect(p.roles[1].target).not.toBe(oldRole.agent)
  expect(p.roles[1].definition).toEqual(b.process.roles[1])
  expect(p.skills[0].existing).toBe("different")
  expect(p.skills[0].target).not.toBe(oldSkill.id)
  expect(p.skills[0].definition).toEqual(b.process.skills[0])
  expect(p.remapped.recommendedRoles).toEqual([p.roles[1].target])
  expect(p.remapped.skillAssignments[1].target).toEqual({ kind: "role", role: p.roles[1].target })
  expect(p.remapped.skillAssignments[0].skills).toEqual([p.skills[0].target])
  expect(p.requirements.mcp).toEqual([{ name: "docs", state: "disabled" }])
  expect(p.permissionsGranted).toBe(false)
  expect(p.overwritesExisting).toBe(false)
  expect(p.startsAutomatically).toBe(false)
  expect(p.activation).toBe("blocked-until-reviewed-install-and-dependency-check")
  expect({ roles: d.roles, skills: d.skills, mcp: d.mcp }).toEqual(before)
  expect(Plan.prepare(text, d)).toEqual(p)
})
test("reserved runtime roles cannot be silently overwritten or renamed", () => {
  const { d, text } = setup(); d.roles = [{ ...d.roles[0], rules: "Different orchestrator" }]
  const p = Plan.prepare(text, d)
  expect(p.requirements.coreRoleDifferences).toEqual(["orchestrator"])
  expect(p.roles[0].action).toBe("blocked-core-difference")
  expect(p.roles[0].target).toBe("orchestrator")
})
test("missing models/programs/providers, login and credential slots remain explicit requirements", () => {
  const { d, text } = setup(); d.models = new Set(); d.programs = new Set(); d.providers = new Set(); d.mcp = new Map()
  const p = Plan.prepare(text, d)
  expect(p.requirements.missingModels).toEqual(["demo/free", "demo/backup#careful", "demo/free#careful", "demo/backup"])
  expect(p.requirements.missingPrograms).toEqual(["git"])
  expect(p.requirements.missingProviders).toEqual(["demo"])
  expect(p.requirements.mcp).toEqual([{ name: "docs", state: "missing" }])
  expect(p.requirements.credentialSlots).toEqual(["service", "shared"])
  expect(p.requirements.browsersNeedSignIn).toEqual(["inbox"])
})
test("destination collisions, ambiguous state and changed review fail closed", () => {
  const { d, text } = setup(), p = Plan.prepare(text, d)
  const occupied = { ...d, roles: [...d.roles, { ...p.roles[1].definition, agent: p.roles[1].target }] }
  expect(() => Plan.prepare(text, occupied)).toThrow("already occupied")
  expect(() => Plan.prepare(text, { ...d, skills: [{ ...p.skills[0].definition, id: p.skills[0].target }] })).toThrow("already occupied")
  expect(() => Plan.prepare(text, { ...d, roles: [...d.roles, d.roles[0]] })).toThrow("ambiguous")
  expect(() => Plan.prepare(text, { ...d, reviewedDigest: "changed" })).toThrow("changed after review")
  expect(() => Plan.prepare(text, { ...d, installedVersion: "0.9.0" })).toThrow()
})
