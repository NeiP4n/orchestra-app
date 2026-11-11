import { expect, test } from "bun:test"
import { ProjectTemplateImport } from "../src/project-template-import"
import { ProjectTemplate } from "../src/project-template"
import { templateFixture } from "./project-template.test"
const bundle = () => templateFixture()
function fixture() {
  const input = bundle(),
    preview = ProjectTemplate.preview(JSON.stringify(input))
  if (!preview.ok) throw Error()
  const destination: ProjectTemplateImport.Destination = {
    projectID: "prj_new",
    installedVersion: "1.0.0",
    reviewedDigest: preview.value.digest,
    now: Date.parse("2026-11-10T12:00:00Z"),
    timezone: "Asia/Baku",
    sessions: { main: "ses_new" },
    browsers: { inbox: "brw_new" },
    schedules: { watch: "trg_new" },
    availableRoles: new Set(["orchestrator"]),
    availableModels: new Set(["demo/free"]),
  }
  return { input, preview: preview.value, destination }
}
test("destination prep resets all authority/runtime state and preserves exact configuration", () => {
  const f = fixture(),
    plan = ProjectTemplateImport.prepare(f.preview.text, f.destination)
  expect(plan.sessions[0]).toMatchObject({
    id: "ses_new",
    title: "Main",
    role: "orchestrator",
    messages: [],
    inheritedPermissions: false,
  })
  expect(plan.browsers[0]).toMatchObject({
    id: "brw_new",
    profile: "new",
    state: "not-opened",
    savedLinks: ["https://example.com/inbox"],
  })
  expect(plan.schedules[0]).toMatchObject({
    id: "trg_new",
    spec: "brw_new",
    projectID: "prj_new",
    enabled: false,
    publishApproved: false,
    nextAt: null,
    fired: [],
    total: 0,
  })
  expect(plan.localVaultSlots[0]).toEqual({
    name: "service",
    type: "api-key",
    label: "Service key",
    state: "empty",
    allowedSessionIDs: [],
  })
  expect(plan.globalRequirements).toEqual([{ name: "shared", state: "binding-required" }])
  expect(plan.started).toBe(false)
})
for (const mutate of [
  (d: ProjectTemplateImport.Destination) => (d.reviewedDigest = "wrong"),
  (d: ProjectTemplateImport.Destination) => (d.availableRoles = new Set()),
  (d: ProjectTemplateImport.Destination) => (d.availableModels = new Set()),
  (d: ProjectTemplateImport.Destination) => (d.sessions = { other: "ses_new" }),
  (d: ProjectTemplateImport.Destination) => (d.browsers = {}),
  (d: ProjectTemplateImport.Destination) => (d.schedules = { watch: "../unsafe" }),
  (d: ProjectTemplateImport.Destination) => (d.installedVersion = "0.9.0"),
  (d: ProjectTemplateImport.Destination) => (d.timezone = "No/SuchTimezone"),
])
  test(`invalid destination blocks all prep: ${String(mutate).slice(0, 60)}`, () => {
    const f = fixture()
    mutate(f.destination)
    expect(() => ProjectTemplateImport.prepare(f.preview.text, f.destination)).toThrow()
  })
test("rules map exact scopes, no project-wide widening, long rules refuse rather than truncate", () => {
  const f = fixture()
  f.input.rules = [
    { scope: "orchestrator", session: null, text: "Main only" },
    { scope: "session", session: "main", text: "One session" },
    { scope: "role", role: "orchestrator", session: null, text: "One role" },
  ]
  let p = ProjectTemplate.preview(JSON.stringify(f.input))
  if (!p.ok) throw Error()
  f.destination.reviewedDigest = p.value.digest
  const plan = ProjectTemplateImport.prepare(p.value.text, f.destination)
  expect(plan.rules.map((r) => r.scope)).toEqual([
    "orchestrator:prj_new",
    "session:ses_new",
    "role:prj_new:orchestrator",
  ])
  f.input.rules[0].text = "x".repeat(241)
  p = ProjectTemplate.preview(JSON.stringify(f.input))
  if (!p.ok) throw Error()
  f.destination.reviewedDigest = p.value.digest
  expect(() => ProjectTemplateImport.prepare(p.value.text, f.destination)).toThrow()
})
test("past once and internal action events never turn into silently altered or enabled schedules", () => {
  for (const source of [
    { kind: "once", spec: "2020-01-01T00:00:00Z" },
    { kind: "execution.succeeded", session: "main" },
  ] as const) {
    const f = fixture()
    f.input.schedules[0].source = source
    const p = ProjectTemplate.preview(JSON.stringify(f.input))
    if (!p.ok) throw Error()
    f.destination.reviewedDigest = p.value.digest
    expect(() => ProjectTemplateImport.prepare(p.value.text, f.destination)).toThrow()
  }
})
test('main and BrowserAgent destination links are exact, not guessed from row order', () => {
 const f = fixture(); f.input.sessions.unshift({ slot: 'browser_agent', title: 'Inbox', role: 'team-browser-agent', model: null }); f.input.mainSession = 'main'; f.input.browsers[0].session = 'browser_agent'
 f.destination.sessions = { main: 'ses_main_new', browser_agent: 'ses_browser_new' }; f.destination.availableRoles = new Set(['orchestrator','team-browser-agent'])
 const preview = ProjectTemplate.preview(JSON.stringify(f.input)); if (!preview.ok) throw Error(); f.destination.reviewedDigest = preview.value.digest
 const plan = ProjectTemplateImport.prepare(preview.value.text,f.destination)
 expect(plan.mainSessionID).toBe('ses_main_new'); expect(plan.browsers[0].chat).toBe('ses_browser_new')
 f.input.mainSession = 'browser_agent'; const bad = ProjectTemplate.preview(JSON.stringify(f.input)); if (!bad.ok) throw Error(); f.destination.reviewedDigest = bad.value.digest
 expect(() => ProjectTemplateImport.prepare(bad.value.text,f.destination)).toThrow('Orchestrator')
})

for (const bound of [false, true]) test(`browser watcher/interval survives omitted links, is fresh, signed out and paused (${bound})`, () => {
  const f = fixture()
  f.input.browsers[0].links = []
  if (bound) f.input.schedules[0].source = { kind: "interval", spec: "60", browser: "inbox" }
  const preview = ProjectTemplate.preview(JSON.stringify(f.input))
  if (!preview.ok) throw Error(preview.error)
  const plan = ProjectTemplateImport.prepare(preview.value.text, { ...f.destination, reviewedDigest: preview.value.digest })
  expect(plan.schedules).toHaveLength(1)
  expect(plan.schedules[0]).toMatchObject({ enabled: false, publishApproved: false, nextAt: null, projectID: "prj_new" })
  expect(bound ? plan.schedules[0].browserSessionID : plan.schedules[0].spec).toBe("brw_new")
  expect(plan.schedules[0].pausedReason).toContain("Нужна привязка заново")
  expect(plan.schedules[0].pausedReason).toContain("войдите в аккаунт")
  expect(plan.browsers[0]).toMatchObject({ id: "brw_new", savedLinks: [], login: "required", profile: "new", state: "not-opened" })
  expect(plan.started).toBe(false)
})

test("ordinary auto role stays unpinned, but cannot replace required main or BrowserAgent roles", () => {
  const f = fixture()
  f.input.sessions.push({ slot: "auto", title: "Приветствие auto", role: null, model: null })
  f.input.mainSession = "main"
  f.destination.sessions = { ...f.destination.sessions, auto: "ses_auto_new" }
  const prepare = () => {
    const preview = ProjectTemplate.preview(JSON.stringify(f.input))
    if (!preview.ok) throw Error(preview.error)
    return ProjectTemplateImport.prepare(preview.value.text, { ...f.destination, reviewedDigest: preview.value.digest })
  }
  expect(prepare().sessions.find(row => row.id === "ses_auto_new")?.role).toBeNull()
  f.input.mainSession = "auto"
  expect(prepare).toThrow("Orchestrator")
  f.input.mainSession = "main"
  f.input.browsers[0].session = "auto"
  expect(prepare).toThrow("BrowserAgent")
})
