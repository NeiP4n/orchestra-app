import { expect, test } from "bun:test"
import { Trigger } from "@orchestra/core/trigger"
import { TriggerBundle as B } from "@orchestra/core/trigger-bundle"
const now = Date.parse("2026-11-10T08:00:00Z")
const source = () => {
  const result = Trigger.create(
    { kind: "interval", spec: "10", prompt: "PRIVATE task with sk-secret", maxPerHour: 3 },
    { id: "trg_source", projectID: "private-project", now, existing: 0 },
  )
  if (!result.ok) throw Error(result.error)
  return { ...result.trigger, publishApproved: true, total: 12, fired: [now - 1] }
}
const bundle = () => {
  const r = B.fromTriggers([source()])
  if (!r.ok) throw Error(r.error)
  return JSON.stringify(r.value)
}
const context = () => ({
  projectID: "destination",
  now,
  timezone: "UTC",
  existing: 0,
  bindings: { template_1: { id: "trg_new", prompt: "Destination instruction" } },
})
test("portable schedule excludes all private text, source identity, grants and run state by construction", () => {
  const text = bundle()
  for (const value of [
    "PRIVATE",
    "sk-secret",
    "private-project",
    "trg_source",
    "prompt",
    "publishApproved",
    "fired",
    "total",
  ])
    expect(text).not.toContain(value)
  expect(B.parse(text).ok).toBe(true)
})
test("imports into the selected project paused with fresh instruction, no history or grants", () => {
  const result = B.instantiate(bundle(), context())
  expect(result.ok).toBe(true)
  if (!result.ok) throw Error(result.error)
  expect(result.value).toHaveLength(1)
  expect(result.value[0]?.trigger).toMatchObject({
    projectID: "destination",
    id: "trg_new",
    prompt: "Destination instruction",
    enabled: false,
    publishApproved: false,
    total: 0,
    fired: [],
    maxPerHour: 3,
  })
  expect(result.value[0]?.trigger.pendingFire).toBeUndefined()
  expect(Trigger.parse(JSON.parse(JSON.stringify(result.value[0]?.trigger)))).toEqual(result.value[0]?.trigger)
})
test("rejects unknown version, injected instructions, runtime fields and duplicate slots", () => {
  const data = JSON.parse(bundle())
  expect(B.parse(JSON.stringify({ ...data, version: 2 })).ok).toBe(false)
  for (const field of [
    "prompt",
    "projectID",
    "publishApproved",
    "pendingFire",
    "password",
    "headers",
    "actions",
    "enabled",
    "pageText",
    "body",
    "html",
    "browserQueue",
    "credential",
    "vaultBinding",
  ]) {
    expect(B.parse(JSON.stringify({ ...data, templates: [{ ...data.templates[0], [field]: "untrusted" }] })).ok).toBe(
      false,
    )
  }
  expect(B.parse(JSON.stringify({ ...data, templates: [data.templates[0], data.templates[0]] })).ok).toBe(false)
  expect(B.parse("x".repeat(B.MAX_BYTES + 1)).ok).toBe(false)
  expect(B.parse("not json").ok).toBe(false)
})
test("failed preflight has no partial output and never bypasses schedule/cap limits", () => {
  expect(B.instantiate(bundle(), { ...context(), existing: 20 }).ok).toBe(false)
  expect(B.instantiate(bundle(), { ...context(), projectID: "" }).ok).toBe(false)
  expect(B.instantiate(bundle(), { ...context(), bindings: {} }).ok).toBe(false)
  const data = JSON.parse(bundle())
  for (const change of [{ maxPerHour: 99 }, { spec: "1" }, { spec: "https://secret.invalid/token" }]) {
    expect(
      B.instantiate(JSON.stringify({ ...data, templates: [{ ...data.templates[0], ...change }] }), context()).ok,
    ).toBe(false)
  }
  const two = { ...data, templates: [data.templates[0], { ...data.templates[0], slot: "template_2" }] }
  expect(
    B.instantiate(JSON.stringify(two), {
      ...context(),
      bindings: { ...context().bindings, template_2: { id: "trg_new", prompt: "Second" } },
    }).ok,
  ).toBe(false)
})
test("event/browser sources, unlimited caps and local plans require explicit reconfiguration rather than silent changes", () => {
  for (const extra of [
    { kind: "browser" as const },
    { browserSessionID: "private-browser" },
    { maxPerHour: null },
    { actions: [{ kind: "orchestra.log" as const, message: "secret text" }] },
  ]) {
    expect(B.fromTriggers([{ ...source(), ...extra }]).ok).toBe(false)
  }
})

test("secret requirements carry names only; an unbound destination slot blocks the whole import", () => {
  const data = JSON.parse(bundle())
  data.templates[0].secretSlots = ["github.token"]
  const text = JSON.stringify(data)
  expect(B.parse(text).ok).toBe(true)
  const blocked = B.instantiate(text, context())
  expect(blocked.ok).toBe(false)
  if (!blocked.ok) expect(blocked.error).toContain("Secret slots not bound in the selected project: github.token")
  expect(B.instantiate(text, { ...context(), boundSecretSlots: new Set(["other.token"]) }).ok).toBe(false)
  const ready = B.instantiate(text, { ...context(), boundSecretSlots: new Set(["github.token"]) })
  expect(ready.ok).toBe(true)
  if (ready.ok) {
    expect(ready.value[0]?.trigger.enabled).toBe(false)
    expect(ready.value[0]?.secretSlots).toEqual(["github.token"])
  }
  data.templates[0].secretSlots = [{ name: "github.token", value: "sk-secret" }]
  expect(B.parse(JSON.stringify(data)).ok).toBe(false)
  data.templates[0].secretSlots = ["github.token", "github.token"]
  expect(B.parse(JSON.stringify(data)).ok).toBe(false)
})

test("export discards page text and raw binding metadata even if attached to a runtime record", () => {
  const polluted = {
    ...source(),
    pageText: "PRIVATE-PAGE-ACCOUNT-BODY",
    browserQueue: { rows: [{ chat: "PRIVATE-CHAT", text: "PRIVATE-PAGE-ACCOUNT-BODY" }], eventIDs: [], droppedRows: 0 },
    secretSlots: ["PRIVATE-SECRET-VALUE"],
    vaultBinding: { password: "PRIVATE-SECRET-VALUE" },
  }
  const exported = B.fromTriggers([polluted])
  expect(exported.ok).toBe(true)
  const serialized = JSON.stringify(exported)
  expect(serialized).not.toContain("PRIVATE-PAGE-ACCOUNT-BODY")
  expect(serialized).not.toContain("PRIVATE-SECRET-VALUE")
  if (exported.ok) expect(exported.value.templates[0]?.secretSlots).toEqual([])
})
