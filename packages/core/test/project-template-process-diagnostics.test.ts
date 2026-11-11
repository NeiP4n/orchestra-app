import { expect, test } from "bun:test"
import { mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { Effect } from "effect"
import { Orchestra } from "@orchestra/schema/orchestra"
import { ProjectTemplateV2Reader as Reader } from "../src/project-template-v2-reader"
import { ProjectTemplateV2 as V2 } from "../src/project-template-v2"
import { templateDiagnosticOf, templateError, TemplateStageError } from "../src/project-template-errors"

function fixture() {
  const project = { id: "prj_diag", name: "Demo", directory: process.cwd(), main: "ses_main", created: 1 }
  const session = { id: "ses_main", title: "Main", agent: "orchestrator", location: { directory: process.cwd() }, metadata: {} as Record<string, import("effect").Schema.Json> }
  const values = new Map<string, unknown>([["orchestra/project/prj_diag", project], ["orchestra/owner/ses_main", "prj_diag"]])
  const stores: Reader.Stores = {
    kv: { get: key => Effect.succeed(values.get(key)), scan: ({ prefix }) => Effect.succeed({ entries: [...values].filter(([k]) => k.startsWith(prefix)).map(([key, value]) => ({ key, value })) }) },
    getSession: () => Effect.succeed(session), listSessionsInTree: () => Effect.succeed([session]),
    roles: async () => [{ agent: "orchestrator", name: "Orchestrator", description: "", rules: "", category: "Core", readOnly: false }],
    playbook: async () => ({ text: null, recommendedRoles: [] }), skills: async () => ({ definitions: [], assignments: [] }), programs: async () => [],
  }
  const run = () => Reader.capture(stores, project.id, { name: project.name, description: "Demo process", minOrchestraVersion: "1.0.0" }, { browsers: [], vault: [], selectedGlobalSlotIDs: new Set(), providers: [], mcp: [] })
  return { session, values, stores, run }
}

for (const [name, change, stage, reasonCode] of [
  ["damaged fallback list", (f: ReturnType<typeof fixture>) => { f.session.metadata[Orchestra.SessionModelsMetadataKey] = [{ invalid: true }] }, "session-models", "metadata-invalid"],
  ["corrupt rule record", (f: ReturnType<typeof fixture>) => { f.values.set("rules/project:prj_diag", { invalid: true }) }, "base-rules", "metadata-invalid"],
  ["Windows path inside rule", (f: ReturnType<typeof fixture>) => { f.values.set("rules/project:prj_diag", [{ text: "Use C:\\PRIVATE_CANARY\\project" }]) }, "base-rules", "path-not-portable"],
  ["Windows path inside role", (f: ReturnType<typeof fixture>) => { f.stores.roles = async () => [{ agent: "orchestrator", name: "Main", description: "", rules: "Use C:\\PRIVATE_CANARY\\project", category: "Core", readOnly: false }] }, "process-roles", "path-not-portable"],
  ["Windows path inside playbook", (f: ReturnType<typeof fixture>) => { f.stores.playbook = async () => ({ text: "Use C:\\PRIVATE_CANARY\\project", recommendedRoles: [] }) }, "process-playbook", "path-not-portable"],
  ["missing assigned skill", (f: ReturnType<typeof fixture>) => { f.stores.skills = async () => ({ definitions: [], assignments: [{ target: { kind: "project" }, skills: ["missing"] }] }) }, "skill-graph", "dependency-missing"],
  ["unknown source failure", (f: ReturnType<typeof fixture>) => { f.stores.getSession = () => Effect.die(new Error("PRIVATE_CANARY token=PRIVATE_SECRET")) }, "base-sessions", "read-failed"],
] as const) test(`safe process diagnosis: ${name}`, async () => {
  const f = fixture(); change(f)
  const error = await f.run().then(() => undefined, error => error)
  expect(error).toBeInstanceOf(TemplateStageError)
  expect(templateDiagnosticOf(error)).toEqual({ stage, reasonCode })
  expect(JSON.stringify({ diagnostic: templateDiagnosticOf(error), response: templateError(error) })).not.toContain("PRIVATE_")
})

test("portable processes remain byte-identical through safe diagnosis", async () => {
  const f = fixture(), result = await f.run()
  expect(V2.preview(result.text)).toEqual({ ok: true, value: result })
  expect(result.text).not.toContain("diagnostic")
  expect(result.text).not.toContain("reasonCode")
})

for (const linked of [false, true]) test(`skill file diagnostic is bounded for ${linked ? "Windows junction / symlink" : "missing file"}`, async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "template-diag-")))
  const link = root + "-link"
  try {
    if (linked) {
      await writeFile(path.join(root, "SKILL.md"), "# Portable skill\n")
      await symlink(root, link, process.platform === "win32" ? "junction" : "dir")
    }
    const f = fixture()
    f.stores.skills = async () => ({ definitions: [{ id: "demo", name: "Demo", entry: "SKILL.md", root: linked ? link : root, files: ["SKILL.md"], dependencies: [] }], assignments: [{ target: { kind: "project" }, skills: ["demo"] }] })
    const error = await f.run().then(() => undefined, error => error)
    expect(templateDiagnosticOf(error)).toEqual({ stage: "skill-files", reasonCode: linked ? "unsafe-file" : "file-missing" })
    expect(JSON.stringify({ diagnostic: templateDiagnosticOf(error), response: templateError(error) })).not.toContain(root)
  } finally {
    await rm(link, { recursive: true, force: true })
    await rm(root, { recursive: true, force: true })
  }
})

for (const [type, configure] of [
 ["session",(f:ReturnType<typeof fixture>)=>{f.session.agent="team_deleted"}],
 ["rule",(f:ReturnType<typeof fixture>)=>{f.values.set("rules/role:prj_diag:team_deleted",[{text:"Never publish without approval"}])}],
 ["playbook",(f:ReturnType<typeof fixture>)=>{f.stores.playbook=async()=>({text:null,recommendedRoles:["team_deleted"]})}],
 ["skill",(f:ReturnType<typeof fixture>)=>{f.stores.skills=async()=>({definitions:[],assignments:[{target:{kind:"role",role:"team_deleted"},skills:[]}]})}],
] as const) test(`missing ${type} role is archived without losing its configuration`,async()=>{
 const f=fixture();configure(f);const before=JSON.stringify([...f.values]);
 const result=await f.run(), bundle=result.bundle
 expect(bundle.process.unresolvedRoles).toEqual(["team_deleted"])
 expect(bundle.process.roles.some(role=>role.agent==="team_deleted")).toBe(false)
 if(type==="session")expect(bundle.sessions[0].role).toBe("team_deleted")
 if(type==="rule")expect(bundle.rules).toContainEqual({scope:"role",session:null,role:"team_deleted",text:"Never publish without approval"})
 if(type==="playbook")expect(bundle.process.recommendedRoles).toEqual(["team_deleted"])
 if(type==="skill")expect(bundle.process.skillAssignments).toEqual([{target:{kind:"role",role:"team_deleted"},skills:[]}])
 expect(V2.preview(result.text).ok).toBe(true)
 expect(JSON.stringify([...f.values])).toBe(before)
})
test("a missing core role is archived, never replaced by an invented definition",async()=>{
 const f=fixture();f.stores.roles=async()=>[]
 const result=await f.run()
 expect(result.bundle.process.unresolvedRoles).toEqual(["orchestrator"])
 expect(result.bundle.process.roles).toEqual([])
 expect(result.bundle.sessions[0].role).toBe("orchestrator")
})
