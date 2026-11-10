import { expect, test } from "bun:test"
import { ProjectTemplateMaterialize as M } from "../src/project-template-materialize"
import { ProjectTemplateImport } from "../src/project-template-import"
import { ProjectTemplate } from "../src/project-template"
import { templateFixture } from "./project-template.test"
function fixture() {
  const template = templateFixture(),
    p = ProjectTemplate.preview(JSON.stringify(template))
  if (!p.ok) throw Error()
  const plan = ProjectTemplateImport.prepare(p.value.text, {
    projectID: "prj_new",
    installedVersion: "1.0.0",
    reviewedDigest: p.value.digest,
    now: Date.parse("2026-11-10T12:00:00Z"),
    timezone: "Asia/Baku",
    sessions: { main: "ses_new" },
    browsers: { inbox: "brw_new" },
    schedules: { watch: "trg_new" },
    availableRoles: new Set(["orchestrator"]),
    availableModels: new Set(["demo/free"]),
  })
  const reservation: M.Receipt = {
    version: 1,
    createdAt: 1,
    template: p.value.text,
    timezone: "Asia/Baku",
    id: "pti_new",
    projectID: "prj_new",
    name: "Factory",
    directory: "/safe/new",
    digest: plan.digest,
    phase: "reserved",
    plan,
  }
  let stored: M.Receipt | undefined, failed: string | undefined
  const done = new Set<string>(),
    calls: string[] = []
  let published = false
  const action = async (name: string) => {
    calls.push(name)
    done.add(name)
    if (failed === name) {
      failed = undefined
      throw Error("simulated process loss after write")
    }
  }
  let pending = Promise.resolve()
  const ports: M.Ports = {
    lock: async (_id, fn) => {
      const before = pending
      let release!: () => void
      pending = new Promise((r) => (release = r))
      await before
      try {
        return await fn()
      } finally {
        release()
      }
    },
    readReceipt: async () => (stored ? structuredClone(stored) : undefined),
    createReceipt: async (r) => {
      if (stored) throw Error()
      stored = structuredClone(r)
    },
    updateReceipt: async (r) => {
      stored = structuredClone(r)
    },
    ensureDirectory: async () => action("directory"),
    ensureSession: async () => action("sessions"),
    ensureRules: async () => action("rules"),
    ensureVault: async () => action("vault"),
    ensureBrowsers: async () => action("browsers"),
    ensureSchedules: async () => action("schedules"),
    verify: async () => {
      calls.push("verify")
      if (!["directory", "sessions", "rules", "vault", "browsers", "schedules"].every((s) => done.has(s)))
        throw Error("incomplete")
    },
    publish: async () => {
      published = true
      await action("publish")
    },
    verifyPublished: async () => {
      if (!published) throw Error()
    },
  }
  return {
    reservation,
    ports,
    service: M.make(ports),
    calls,
    done,
    fail: (at: string) => {
      failed = at
    },
    isPublished: () => published,
    receipt: () => stored,
  }
}
for (const at of ["directory", "sessions", "rules", "vault", "browsers", "schedules", "publish"])
  test(`recovers exact identity after interrupted ${at} write and publishes last`, async () => {
    const f = fixture()
    f.fail(at)
    await expect(f.service.apply(f.reservation)).rejects.toThrow()
    expect(f.isPublished()).toBe(at === "publish")
    const result = await f.service.apply(f.reservation)
    expect(result.phase).toBe("published")
    expect(f.isPublished()).toBe(true)
    expect(f.calls.filter((c) => c === at).length).toBe(2)
    expect(result.plan.schedules[0].enabled).toBe(false)
    expect(result.plan.localVaultSlots[0].allowedSessionIDs).toEqual([])
    expect(f.calls.lastIndexOf("verify")).toBeLessThan(f.calls.lastIndexOf("publish"))
  })
test("concurrent confirms serialize and published confirmation does not repeat any store write", async () => {
  const f = fixture()
  await Promise.all([f.service.apply(f.reservation), f.service.apply(f.reservation)])
  expect(f.calls.filter((c) => c === "publish")).toHaveLength(1)
  expect(f.calls.filter((c) => c === "sessions")).toHaveLength(1)
  const before = f.calls.length
  await f.service.apply(f.reservation)
  expect(f.calls).toHaveLength(before)
})
test("foreign receipt, changed reservation and enabled schedule are rejected before any write", async () => {
  const f = fixture()
  await f.service.apply(f.reservation)
  await expect(f.service.apply({ ...f.reservation, name: "Changed" })).rejects.toThrow("differs")
  const bad = fixture()
  bad.reservation.plan.schedules[0].enabled = true
  await expect(bad.service.apply(bad.reservation)).rejects.toThrow("inert")
  expect(bad.calls).toEqual([])
})
test("resume validates already-written stores and refuses publication when they changed", async () => {
  const f = fixture()
  f.fail("schedules")
  await expect(f.service.apply(f.reservation)).rejects.toThrow()
  f.done.delete("vault")
  await expect(f.service.apply(f.reservation)).rejects.toThrow("incomplete")
  expect(f.isPublished()).toBe(false)
})
