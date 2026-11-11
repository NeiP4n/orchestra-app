import { expect, test } from "bun:test"
import { ProjectTemplateSource } from "../src/project-template-source"
const metadata = { name: "Reusable factory", description: "Configuration only", minOrchestraVersion: "1.0.0" }
const source = (): ProjectTemplateSource.Source => ({
  project: { id: "prj_PRIVATE", name: "Factory" },
  sessions: [{ id: "ses_PRIVATE", title: "Main", agent: "orchestrator", model: { providerID: "demo", modelID: "free" }, ...{ messages: ["PRIVATE-CANARY"] } }], ownedSessionIDs: new Set(["ses_PRIVATE"]),
  browsers: [{ id: "br_PRIVATE", name: "Inbox", projectID: "prj_PRIVATE", mode: "window", savedLinks: ["https://example.com/inbox"], ...{ cookies: "PRIVATE-CANARY", pageText: "PRIVATE-CANARY" } }],
  rules: [{ scope: "project", text: "Review work." }, { scope: "session", sessionID: "ses_PRIVATE", text: "Ask before publishing." }],
  schedules: [{ id: "trg_PRIVATE", projectID: "prj_PRIVATE", kind: "browser", spec: "br_PRIVATE", prompt: "Report changes.", enabled: true, createdAt: 1, nextAt: null, fired: [1], total: 100, maxPerHour: 6, maxPerDay: 48, publishApproved: true }],
  vault: [{ id: "vlt_PRIVATE", name: "service", label: "Service", type: "api-key", scope: "project", projectID: "prj_PRIVATE", state: "filled", allowedSessionIDs: ["ses_PRIVATE"], ...{ blob: "PRIVATE-CANARY" } }, { id: "global_selected", name: "shared", type: "login", label: "Shared", scope: "global", state: "filled", allowedSessionIDs: [] }, { id: "global_other", name: "unrelated", label: "Unrelated", type: "login", scope: "global", state: "filled", allowedSessionIDs: [] }],
  selectedGlobalSlotIDs: new Set(["global_selected"]), providers: [{ id: "demo", endpoint: null, credentialSlots: ["service"] }], mcp: [],
})
test("capture projects configuration through an allowlist, remaps references and excludes all runtime payloads", () => {
  const result = ProjectTemplateSource.capture(source(), metadata); expect(result.ok).toBe(true); if (!result.ok) throw Error(result.error)
  const output = result.value
  expect(output.bundle.vault).toEqual({ local: [{ name: "service", label: "Service", type: "api-key" }], globalRequirements: ["shared"] })
  expect(output.bundle.rules[1].session).toBe("session_1")
  expect(output.bundle.schedules[0].source).toEqual({ kind: "browser", browser: "browser_1", match: null })
  expect(output.text).not.toMatch(/PRIVATE|unrelated|enabled|publishApproved|allowedSessionIDs|cookies|messages|blob|createdAt|fired/)
})
for (const change of [
  (s: ProjectTemplateSource.Source) => s.ownedSessionIDs = new Set(["foreign"]),
  (s: ProjectTemplateSource.Source) => s.sessions = [],
  (s: ProjectTemplateSource.Source) => s.browsers[0].projectID = "foreign",
  (s: ProjectTemplateSource.Source) => s.vault[0].projectID = "foreign",
  (s: ProjectTemplateSource.Source) => s.selectedGlobalSlotIDs = new Set(["missing"]),
  (s: ProjectTemplateSource.Source) => s.selectedGlobalSlotIDs = new Set(["vlt_PRIVATE"]),
  (s: ProjectTemplateSource.Source) => s.schedules[0].maxPerHour = null,
  (s: ProjectTemplateSource.Source) => s.schedules[0].actions = [{ kind: "orchestra.log", message: "x" }],
  (s: ProjectTemplateSource.Source) => s.schedules[0].condition = { type: "browser", event: "incoming-row", sessionID: "foreign" },
  (s: ProjectTemplateSource.Source) => s.rules = [{ scope: "session", sessionID: "foreign", text: "Rule" }],
]) test(`incomplete ownership or unsupported source rejects entire capture (${String(change).slice(0, 50)})`, () => {
  const s = source(); change(s); const result = ProjectTemplateSource.capture(s, metadata)
  expect(result.ok).toBe(false); expect(JSON.stringify(result)).not.toContain("PRIVATE")
})
test("time and browser structural conditions preserve source semantics and never runtime approval", () => {
  const s = source(); s.schedules = [{ ...s.schedules[0], kind: "interval", spec: "60", condition: { type: "time", kind: "interval", spec: "60" } }]
  const result = ProjectTemplateSource.capture(s, metadata); expect(result.ok).toBe(true)
  if (result.ok) expect(result.value.bundle.schedules[0].source).toEqual({ kind: "interval", spec: "60" })
  s.schedules[0].condition = { type: "time", kind: "interval", spec: "5" }; expect(ProjectTemplateSource.capture(s, metadata).ok).toBe(false)
})
test("saved link queries or a secret-bearing rule reject capture rather than stripping source bytes", () => {
  const s = source(); s.browsers[0].savedLinks = ["https://example.com/?token=private"]; expect(ProjectTemplateSource.capture(s, metadata).ok).toBe(false)
  s.browsers[0].savedLinks = []; s.rules[0].text = "password=hunter2"; const result = ProjectTemplateSource.capture(s, metadata); expect(result.ok).toBe(false); expect(JSON.stringify(result)).not.toContain("hunter2")
})

test("scheduled read-only browser checks keep exact interval and portable browser binding", () => {
  const s = source()
  s.schedules = [{ ...s.schedules[0], kind: "interval", spec: "60", browserSessionID: "br_PRIVATE", condition: { type: "time", kind: "interval", spec: "60" } }]
  s.browsers[0].savedLinks = []
  const captured = ProjectTemplateSource.capture(s, metadata)
  expect(captured.ok).toBe(true)
  if (captured.ok) expect(captured.value.bundle.schedules[0].source).toEqual({ kind: "interval", spec: "60", browser: "browser_1" })
  s.schedules[0].browserSessionID = "foreign"
  expect(ProjectTemplateSource.capture(s, metadata).ok).toBe(false)
  s.schedules[0].browserSessionID = "br_PRIVATE"; s.schedules[0].spec = "5"; s.schedules[0].condition = { type: "time", kind: "interval", spec: "5" }
  expect(ProjectTemplateSource.capture(s, metadata).ok).toBe(false)
})
