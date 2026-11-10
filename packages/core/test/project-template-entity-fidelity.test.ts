import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ProjectTemplateSource as S } from "../src/project-template-source"
import { ProjectTemplateImport as I } from "../src/project-template-import"
import { templateFixture } from "./project-template.test"
import { ProjectTemplate } from "../src/project-template"
import { ProjectTemplateLibrary as L } from "../src/project-template-library"

test("every supported definition survives capture -> disk save/read -> import field-for-field", async () => {
  const source: S.Source = {
    project: { id: "prj_src", name: "Factory", main: "ses_main" },
    sessions: [
      { id: "ses_main", title: "Main", agent: "orchestrator", model: { providerID: "demo", modelID: "reason", variant: "careful" } },
      { id: "ses_browser", title: "BrowserAgent", agent: "team-browser-agent", model: { providerID: "demo", modelID: "browser" } },
      { id: "ses_worker", title: "Worker", agent: "team-builder" },
    ], ownedSessionIDs: new Set(["ses_main", "ses_browser", "ses_worker"]),
    browsers: [{ id: "brw_src", name: "Inbox", projectID: "prj_src", mode: "headless", chat: "ses_browser", savedLinks: ["https://example.com/inbox", "https://example.org/report"] }],
    rules: [
      { scope: "project", text: "Project rule." }, { scope: "project-defaults", text: "Independent defaults." },
      { scope: "orchestrator", text: "Orchestrator rule." }, { scope: "session", sessionID: "ses_worker", text: "Worker rule." },
      { scope: "role", role: "team-builder", text: "Role rule." },
    ], schedules: [],
    vault: [
      { id: "vlt_local", name: "service", label: "Service", type: "api-key", scope: "project", projectID: "prj_src", state: "filled", allowedSessionIDs: ["ses_worker"] },
      { id: "vlt_global", name: "shared", label: "Shared", type: "login", scope: "global", state: "filled", allowedSessionIDs: [] },
    ], selectedGlobalSlotIDs: new Set(["vlt_global"]),
    providers: [{ id: "demo", endpoint: "https://example.com/v1", credentialSlots: ["service"] }],
    mcp: [{ name: "docs", catalog: "context7", credentialSlots: ["shared"] }],
  }
  const captured = S.capture(source, { name: "Reusable factory", description: "Configuration only", minOrchestraVersion: "1.0.0+build1" })
  if (!captured.ok) throw Error(captured.error)
  const root = await mkdtemp(path.join(os.tmpdir(), "entity-fidelity-"))
  try {
    await L.local(root).saveSerialized(captured.value.text, "factory", captured.value.digest)
    const loaded = await L.local(root).preview("factory")
    expect(loaded.bundle).toEqual(captured.value.bundle)
    expect(loaded.bundle.variables).toEqual({ projectName: "Factory", folder: "${projectFolder}" })
    expect(loaded.bundle.minOrchestraVersion).toBe("1.0.0+build1")
    const plan = I.prepare(loaded.text, {
      projectID: "prj_new", installedVersion: "1.0.0+different", reviewedDigest: loaded.digest, now: 1794330000000, timezone: "Asia/Baku",
      sessions: { session_1: "ses_new_main", session_2: "ses_new_browser", session_3: "ses_new_worker" }, browsers: { browser_1: "brw_new" }, schedules: {},
      availableRoles: new Set(["orchestrator", "team-browser-agent", "team-builder"]), availableModels: new Set(["demo/reason#careful", "demo/browser"]),
    })
    expect(plan.sessions.map(({ id, slot, messages, inheritedPermissions, ...definition }) => definition)).toEqual([
      { title: "Main", role: "orchestrator", model: { provider: "demo", id: "reason", variant: "careful" } },
      { title: "BrowserAgent", role: "team-browser-agent", model: { provider: "demo", id: "browser", variant: null } },
      { title: "Worker", role: "team-builder", model: null },
    ])
    expect(plan.sessions.every((row) => !row.inheritedPermissions && row.messages.length === 0)).toBe(true)
    expect(plan.mainSessionID).toBe("ses_new_main")
    expect(plan.browsers).toEqual([{ id: "brw_new", slot: "browser_1", name: "Inbox", mode: "headless", chat: "ses_new_browser", savedLinks: [...source.browsers[0].savedLinks], profile: "new", login: "required", state: "not-opened" }])
    expect(plan.rules).toEqual([
      { scope: "project:prj_new", text: "Project rule." }, { scope: "project-defaults:prj_new", text: "Independent defaults." },
      { scope: "orchestrator:prj_new", text: "Orchestrator rule." }, { scope: "session:ses_new_worker", text: "Worker rule." },
      { scope: "role:prj_new:team-builder", text: "Role rule." },
    ])
    expect(plan.localVaultSlots).toEqual([{ name: "service", label: "Service", type: "api-key", state: "empty", allowedSessionIDs: [] }])
    expect(plan.globalRequirements).toEqual([{ name: "shared", state: "binding-required" }])
    expect(plan.integrationRequirements).toEqual({ providers: source.providers, mcp: source.mcp })
    expect(plan.started).toBe(false)
    expect(I.sessionModelRef(plan.sessions[0].model)).toEqual({ providerID: "demo", id: "reason", variant: "careful" })
    expect(I.sessionModelRef(plan.sessions[1].model)).toEqual({ providerID: "demo", id: "browser" })
    expect(I.sessionModelRef(plan.sessions[2].model)).toBeUndefined()
    expect(loaded.warnings.join(" ")).toContain("Skills, role definitions")
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("manual template files cannot bypass local browser URL restrictions", async () => {
  for (const link of ["http://localhost:3000/", "http://127.0.0.1/", "http://192.168.0.1/", "http://[::1]/", "file:///private"]) {
    const bundle = templateFixture(); bundle.browsers[0].links = [link]
    expect(ProjectTemplate.parse(JSON.stringify(bundle)).ok).toBe(false)
  }
})
