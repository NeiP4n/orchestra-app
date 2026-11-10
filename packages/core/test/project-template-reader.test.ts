import { expect, test } from "bun:test"
import { Effect } from "effect"
import { ProjectTemplateReader } from "../src/project-template-reader"
const metadata = { name: "Factory", description: "Configuration only", minOrchestraVersion: "1.0.0" }
const linked = { browsers: [], vault: [], selectedGlobalSlotIDs: new Set<string>(), providers: [], mcp: [] }
function fixture() {
  const values = new Map<string, unknown>([
    ["orchestra/project/prj_a", { id: "prj_a", name: "Factory", directory: "/work", created: 1, main: "ses_main" }],
    [
      "orchestra/project/prj_b",
      { id: "prj_b", name: "Nested", directory: "/work/nested", created: 2, main: "ses_other" },
    ],
    ["orchestra/owner/ses_main", "prj_a"],
    ["orchestra/owner/ses_foreign", "prj_b"],
    ["rules/project:prj_a", [{ id: "r1", text: "Project rule", by: "operator", at: 1 }]],
    ["rules/project-defaults:prj_a", [{ id: "r2", text: "Default copy", by: "operator", at: 1 }]],
    ["rules/orchestrator:prj_a", [{ id: "r3", text: "Orchestrator rule", by: "operator", at: 1 }]],
    ["rules/role:prj_a:builder", [{ id: "r4", text: "Builder rule", by: "operator", at: 1 }]],
    ["rules/session:ses_main", [{ id: "r5", text: "Session rule", by: "operator", at: 1 }]],
  ])
  const sessions = new Map<string, ProjectTemplateReader.SessionMetadata>([
    ["ses_main", { id: "ses_main", title: "Main", agent: "orchestrator", location: { directory: "/work" } }],
    ["ses_unclaimed", { id: "ses_unclaimed", title: "Builder", agent: "builder", location: { directory: "/work" } }],
    ["ses_foreign", { id: "ses_foreign", title: "Not exported", agent: "builder", location: { directory: "/work" } }],
    [
      "ses_nested",
      { id: "ses_nested", title: "Not exported either", agent: "builder", location: { directory: "/work/nested" } },
    ],
    [
      "ses_child",
      { id: "ses_child", parentID: "ses_main", title: "Child", agent: "builder", location: { directory: "/work" } },
    ],
  ])
  const reads: string[] = []
  const stores: ProjectTemplateReader.Stores = {
    kv: {
      get: (key) =>
        Effect.sync(() => {
          reads.push(key)
          return values.get(key)
        }),
      scan: ({ prefix, after, limit = 1000 }) =>
        Effect.sync(() => {
          const rows = [...values]
            .filter(([key]) => key.startsWith(prefix) && (!after || key > after))
            .sort(([a], [b]) => a.localeCompare(b))
          const page = rows.slice(0, limit)
          return {
            entries: page.map(([key, value]) => ({ key, value })),
            ...(rows.length > page.length ? { next: page.at(-1)![0] } : {}),
          }
        }),
    },
    getSession: (id) => Effect.sync(() => sessions.get(id)),
    listSessionsInTree: () => Effect.succeed([...sessions.values()]),
  }
  return { stores, values, sessions, reads }
}
test("passive live-store projection includes unclaimed in-tree sessions, excludes nested/foreign/child and retains every rule scope", async () => {
  const f = fixture()
  const result = await Effect.runPromise(ProjectTemplateReader.capture(f.stores, "prj_a", metadata, linked))
  expect(result.bundle.sessions.map((s) => s.title)).toEqual(["Main", "Builder"])
  expect(result.bundle.rules.map((s) => s.scope)).toEqual([
    "project",
    "project-defaults",
    "orchestrator",
    "session",
    "role",
  ])
  expect(result.text).not.toMatch(/ses_|prj_|\/work|Not exported/)
  expect(f.reads.every((key) => /^(orchestra\/project\/|rules\/)/.test(key))).toBe(true)
})
for (const kind of ["missing-session", "damaged-rule", "changed-project", "damaged-trigger", "repeating-page"] as const)
  test(`source ${kind} blocks the whole snapshot`, async () => {
    const f = fixture()
    if (kind === "missing-session") f.sessions.delete("ses_main")
    if (kind === "damaged-rule") f.values.set("rules/project:prj_a", { invalid: true })
    if (kind === "damaged-trigger") f.values.set("orchestra/trigger/prj_a/trg_bad", { invalid: true })
    if (kind === "changed-project") {
      let count = 0
      const get = f.stores.kv.get
      f.stores.kv.get = (key) => {
        if (key === "orchestra/project/prj_a" && ++count === 2)
          return Effect.succeed({ ...(f.values.get(key) as object), name: "Changed" })
        return get(key)
      }
    }
    if (kind === "repeating-page")
      f.stores.kv.scan = ({ after }) => Effect.succeed({ entries: [], next: after ?? "same" })
    await expect(
      Effect.runPromise(ProjectTemplateReader.capture(f.stores, "prj_a", metadata, linked)),
    ).rejects.toThrow()
  })
test("owner scan traverses beyond 1000 unrelated sessions without creating or reading any message", async () => {
  const f = fixture()
  for (let i = 0; i < 1200; i++) f.values.set(`orchestra/owner/ses_a${i.toString().padStart(4, "0")}`, "prj_b")
  const result = await Effect.runPromise(ProjectTemplateReader.capture(f.stores, "prj_a", metadata, linked))
  expect(result.bundle.sessions).toHaveLength(2)
})


test("legacy child and deleted-session ownership markers do not poison a live top-level project export", async () => {
  const f = fixture()
  f.values.set("orchestra/owner/ses_child", "prj_a")
  f.values.set("orchestra/owner/ses_deleted_worker", "prj_a")
  const result = await Effect.runPromise(ProjectTemplateReader.capture(f.stores, "prj_a", metadata, linked))
  expect(result.bundle.sessions.map(session => session.title)).toEqual(["Main", "Builder"])
  expect(result.text).not.toContain("Child")
  expect(f.values.get("orchestra/owner/ses_child")).toBe("prj_a")
  expect(f.values.get("orchestra/owner/ses_deleted_worker")).toBe("prj_a")
})

test("a claimed main that is missing, a child, or belongs to another owner still blocks export", async () => {
  for (const state of ["missing", "child", "foreign"]) {
    const f = fixture()
    if (state === "missing") f.sessions.delete("ses_main")
    else if (state === "child") f.sessions.get("ses_main")!.parentID = "ses_parent"
    else f.values.set("orchestra/owner/ses_main", "prj_b")
    await expect(Effect.runPromise(ProjectTemplateReader.capture(f.stores, "prj_a", metadata, linked))).rejects.toThrow(state === "missing" ? "Project main session is missing" : state === "child" ? "Project main session points to a child task" : "Project main session belongs to another project")
  }
})
