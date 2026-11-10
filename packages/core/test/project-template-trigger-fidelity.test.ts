import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { Trigger } from "../src/trigger"
import { ProjectTemplateSource } from "../src/project-template-source"
import { ProjectTemplateLibrary } from "../src/project-template-library"
import { ProjectTemplateImport } from "../src/project-template-import"

const now = Date.parse("2026-11-10T18:00:00Z")
const inputs: [string, Trigger.CreateInput][] = [
  ["cron", { kind: "cron", spec: "15 8 * * 1-5", condition: { type: "time", kind: "cron", spec: "15 8 * * 1-5" }, prompt: "Review the daily report.", maxPerHour: 3, maxPerDay: 9, missedPolicy: "catch-up" }],
  ["interval", { kind: "interval", spec: "75", prompt: "Check local status.", maxPerHour: 2, maxPerDay: 16, missedPolicy: "skip" }],
  ["once", { kind: "once", spec: "2026-12-15T10:30:00+04:00", condition: { type: "time", kind: "once", spec: "2026-12-15T10:30:00+04:00" }, prompt: "Prepare the release checklist.", maxPerHour: 1, maxPerDay: 1, missedPolicy: "run-once" }],
  ["browser", { kind: "browser", spec: "brw_source", condition: { type: "browser", event: "incoming-row", sessionID: "brw_source", match: "Orders" }, match: "Orders", prompt: "Review new orders, ask before acting.", maxPerHour: 6, maxPerDay: 24, missedPolicy: "skip" }],
  // WhatsApp has no separate trigger kind. It is the existing browser incoming-row watcher.
  ["whatsapp", { kind: "browser", spec: "brw_source", condition: { type: "browser", event: "incoming-row", sessionID: "brw_source", match: "Team chat" }, match: "Team chat", prompt: "Summarize incoming WhatsApp items. Do not send replies.", maxPerHour: 4, maxPerDay: 20, missedPolicy: "skip" }],
  ["browser-interval", { kind: "interval", spec: "120", browserSessionID: "brw_source", condition: { type: "time", kind: "interval", spec: "120" }, prompt: "Read the bound page and report changes.", maxPerHour: 2, maxPerDay: 12, missedPolicy: "run-once" }],
]

for (const [name, input] of inputs) test(`capture -> actual library save/load -> create preserves exact trigger config: ${name}`, async () => {
  const made = Trigger.create(input, { id: "trg_source", projectID: "prj_source", now, timezone: "Asia/Baku", existing: 0 })
  if (!made.ok) throw Error(made.error)
  const original = { ...made.trigger, publishApproved: true, total: 9, fired: [now - 1000], lastFiredAt: now - 1000, missedCount: 2 }
  const source: ProjectTemplateSource.Source = {
    project: { id: "prj_source", name: "Factory", main: "ses_main" },
    sessions: [
      { id: "ses_main", title: "Main", agent: "orchestrator", model: { providerID: "demo", modelID: "free", variant: "careful" } },
      { id: "ses_browser", title: "BrowserAgent", agent: "team-browser-agent", model: { providerID: "demo", modelID: "browser", variant: "fast" } },
    ],
    ownedSessionIDs: new Set(["ses_main", "ses_browser"]),
    browsers: [{ id: "brw_source", name: "Inbox", projectID: "prj_source", chat: "ses_browser", mode: "window", savedLinks: [] }],
    rules: [], schedules: [original], vault: [], selectedGlobalSlotIDs: new Set(), providers: [], mcp: [],
  }
  const captured = ProjectTemplateSource.capture(source, { name: "Factory", description: "Configuration", minOrchestraVersion: "1.0.0" })
  if (!captured.ok) throw Error(captured.error)
  const root = await mkdtemp(path.join(os.tmpdir(), "trigger-fidelity-"))
  try {
    const library = ProjectTemplateLibrary.local(root)
    await library.saveSerialized(captured.value.text, "factory", captured.value.digest)
    const loaded = await ProjectTemplateLibrary.local(root).preview("factory")
    expect(loaded.digest).toBe(captured.value.digest)
    expect(loaded.bundle).toEqual(captured.value.bundle)
    const created = ProjectTemplateImport.prepare(loaded.text, {
      projectID: "prj_destination", installedVersion: "1.0.0", reviewedDigest: loaded.digest, now: now + 5000, timezone: "Asia/Baku",
      sessions: { session_1: "ses_new_main", session_2: "ses_new_browser" }, browsers: { browser_1: "brw_destination" }, schedules: { schedule_1: "trg_destination" },
      availableRoles: new Set(["orchestrator", "team-browser-agent"]), availableModels: new Set(["demo/free#careful", "demo/browser#fast"]),
    })
    const actual = created.schedules[0]
    const remap = (id: string) => id === "brw_source" ? "brw_destination" : id
    const expected = {
      ...original, id: "trg_destination", projectID: "prj_destination", spec: original.kind === "browser" ? remap(original.spec) : original.spec,
      ...(original.browserSessionID ? { browserSessionID: remap(original.browserSessionID) } : {}),
      ...(original.condition ? { condition: original.condition.type === "browser" ? { ...original.condition, sessionID: remap(original.condition.sessionID) } : original.condition } : {}),
      enabled: false, nextAt: null, fired: [], total: 0, publishApproved: false, createdAt: now + 5000,
      pausedReason: actual.pausedReason,
    }
    delete (expected as Partial<Trigger.Info>).lastFiredAt
    delete (expected as Partial<Trigger.Info>).missedCount
    // Full-object equality catches any new field silently dropped or changed, not a partial match.
    expect(actual).toEqual(expected)
    expect(created.sessions.map((session) => ({ title: session.title, role: session.role, model: session.model }))).toEqual(
      source.sessions.map((session) => ({ title: session.title!, role: session.agent!, model: { provider: session.model!.providerID, id: session.model!.modelID, variant: session.model!.variant! } })),
    )
    expect(created.browsers[0].chat).toBe("ses_new_browser")
    expect(created.started).toBe(false)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("import refuses match/spec normalization instead of silently changing the template", async () => {
  const { templateFixture } = await import("./project-template.test")
  const { ProjectTemplate } = await import("../src/project-template")
  for (const source of [
    { kind: "browser" as const, browser: "inbox", match: "x".repeat(81) },
    { kind: "browser" as const, browser: "inbox", match: "  Orders  " },
    { kind: "interval" as const, spec: " 60 " },
  ]) {
    const bundle = templateFixture(); bundle.schedules[0].source = source
    const preview = ProjectTemplate.preview(JSON.stringify(bundle))
    if (!preview.ok) { expect(preview.ok).toBe(false); continue }
    expect(() => ProjectTemplateImport.prepare(preview.value.text, {
      projectID: "prj_destination", installedVersion: "1.0.0", reviewedDigest: preview.value.digest, now, timezone: "Asia/Baku",
      sessions: { main: "ses_new" }, browsers: { inbox: "brw_new" }, schedules: { watch: "trg_new" }, availableRoles: new Set(["orchestrator"]), availableModels: new Set(["demo/free"]),
    })).toThrow("changed")
  }
})
