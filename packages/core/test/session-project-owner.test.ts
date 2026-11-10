import { expect, test } from "bun:test"
import { Effect } from "effect"
import { SessionProjectOwner as Owner } from "../src/session/project-owner"
import { BrowserBridge } from "../src/browser/bridge"

function fixture() {
  const values = new Map<string, any>([
    [
      "orchestra/project/prj_test",
      { id: "prj_test", name: "Test3", directory: "/test3", created: 1, main: "ses_main" },
    ],
    ["orchestra/owner/ses_main", "prj_test"],
  ])
  const kv = {
    get: (key: string) => Effect.succeed(values.get(key)),
    scan: ({ prefix }: { prefix: string }) =>
      Effect.succeed({
        entries: [...values].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value })),
      }),
  }
  return { values, kv }
}
const browser = [{ id: "brw_test", name: "Browser 1", project: "/test3", projectID: "prj_test" }]

test("ordinary main with KV owner and no metadata sees and starts its own published browser", async () => {
  const f = fixture(),
    session = { id: "ses_main" }
  // Reproduces previous mismatch: UI browser exists but metadata-only guard denies it.
  expect(BrowserBridge.visible(browser, "/test3")).toEqual([])
  expect(BrowserBridge.ownerRefusal(browser, "brw_test", "/test3")).toContain("no verified")
  const owner = await Effect.runPromise(Owner.resolve(f.kv, session))
  expect(owner).toBe("prj_test")
  expect(BrowserBridge.visible(browser, "/test3", owner)).toEqual(browser)
  expect(BrowserBridge.resolve(browser, "Browser 1", "/test3", owner)).toEqual({ session: browser[0] })
  expect(BrowserBridge.ownerRefusal(browser, "brw_test", "/test3", owner)).toBeUndefined()
  expect(BrowserBridge.ownerRefusal(browser, "brw_test", "/different", owner)).toContain("directory")
})

test("exact legacy Project.main works without marker but directory alone never grants access", async () => {
  const f = fixture()
  f.values.delete("orchestra/owner/ses_main")
  expect(await Effect.runPromise(Owner.resolve(f.kv, { id: "ses_main" }))).toBe("prj_test")
  expect(await Effect.runPromise(Owner.resolve(f.kv, { id: "ses_foreign" }))).toBeUndefined()
  f.values.set("orchestra/project/prj_second", {
    id: "prj_second",
    name: "Other",
    directory: "/other",
    created: 2,
    main: "ses_main",
  })
  expect(await Effect.runPromise(Owner.resolve(f.kv, { id: "ses_main" }))).toBeUndefined()
})

test("conflicting, stale, malformed and moving owners fail closed without repair", async () => {
  for (const kind of ["conflict", "stale", "malformed", "moving"]) {
    const f = fixture(),
      before = JSON.stringify([...f.values])
    let session: any = { id: "ses_main" }
    if (kind === "conflict") session.metadata = { "orchestra:project-owner": { projectID: "prj_other" } }
    if (kind === "stale") f.values.delete("orchestra/project/prj_test")
    if (kind === "malformed") f.values.set("orchestra/owner/ses_main", { projectID: "prj_test" })
    if (kind === "moving") f.values.set("orchestra/move-plan/prj_test", { pending: true })
    const snapshot = JSON.stringify([...f.values])
    expect(await Effect.runPromise(Owner.resolve(f.kv, session))).toBeUndefined()
    expect(JSON.stringify([...f.values])).toBe(snapshot)
  }
})

test("a stable foreign owner remains foreign even in the same directory", async () => {
  const f = fixture()
  f.values.set("orchestra/project/prj_foreign", { id: "prj_foreign", name: "Other", directory: "/test3", created: 2 })
  f.values.set("orchestra/owner/ses_worker", "prj_foreign")
  const owner = await Effect.runPromise(Owner.resolve(f.kv, { id: "ses_worker" }))
  expect(owner).toBe("prj_foreign")
  expect(BrowserBridge.visible(browser, "/test3", owner)).toEqual([])
  expect(BrowserBridge.ownerRefusal(browser, "brw_test", "/test3", owner)).toContain("another project")
})

test("legacy scan pagination is bounded and re-reads the selected main", async () => {
  const f = fixture()
  f.values.delete("orchestra/owner/ses_main")
  let calls = 0
  const paged = { ...f.kv, scan: () => Effect.succeed(++calls === 1 ? { entries: [], next: "next" } : { entries: [{ key: "orchestra/project/prj_test", value: f.values.get("orchestra/project/prj_test") }] }) }
  expect(await Effect.runPromise(Owner.resolve(paged, {id: "ses_main"}))).toBe("prj_test")
  const stale = { ...f.kv, get: () => Effect.succeed(undefined) }
  expect(await Effect.runPromise(Owner.resolve(stale, {id: "ses_main"}))).toBeUndefined()
  let loop = 0
  const cycling = { ...f.kv, scan: () => Effect.succeed({ entries: [], next: String(++loop) }) }
  expect(await Effect.runPromise(Owner.resolve(cycling, {id: "ses_main"}))).toBeUndefined()
  expect(loop).toBe(101)
})
