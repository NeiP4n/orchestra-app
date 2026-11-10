import { expect, test } from "bun:test"
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { Effect } from "effect"
import { ProjectTemplateBrowserStore as Store } from "../src/project-template-browser-store"
import type { KV } from "../src/kv"
import type { ProjectTemplateMaterialize as M } from "../src/project-template-materialize"
async function fixture(
  fn: (
    root: string,
    store: ReturnType<typeof Store.make>,
    receipt: M.Receipt,
    kv: Map<string, KV.Value>,
  ) => Promise<void>,
) {
  const root = await mkdtemp(path.join(os.tmpdir(), "template-browser-store-")),
    values = new Map<string, KV.Value>()
  const kv = {
    get: (key: string) => Effect.sync(() => values.get(key)),
    atomicUpdate: (key: string, f: (value: KV.Value | undefined) => KV.Value | undefined) =>
      Effect.sync(() => {
        const v = f(values.get(key))
        if (v === undefined) values.delete(key)
        else values.set(key, v)
        return v
      }),
  } as KV.Interface
  const receipt = {
    version: 1,
    id: "pti_test",
    projectID: "prj_test",
    createdAt: 1,
    plan: {
      browsers: [
        {
          id: "brw_test",
          name: "Inbox",
          mode: "window",
          savedLinks: Array.from({ length: 12 }, (_, i) => "https://example.com/" + i),
          chat: "ses_test",
          state: "not-opened",
          login: "required",
          profile: "new",
        },
      ],
    },
  } as unknown as M.Receipt
  try {
    await fn(root, Store.make(kv, root), receipt, values)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
test("persists all links and exact BrowserAgent identity, retry never starts a profile", () =>
  fixture(async (root, store, r) => {
    await store.ensure(r, r.plan.browsers)
    await store.ensure(r, r.plan.browsers)
    await store.verify(r, r.plan.browsers)
    expect(
      JSON.parse(await readFile(path.join(root, "browser-profiles/brw_test.tabs.json"), "utf8")).tabs,
    ).toHaveLength(12)
    expect(JSON.stringify(await store.read(r.projectID))).toContain("ses_test")
    expect(await Bun.file(path.join(root, "browser-profiles/brw_test/Cookies")).exists()).toBe(false)
  }))
test("does not adopt any existing profile or same-named saved-links file before reservation", () =>
  fixture(async (root, store, r) => {
    await mkdir(path.join(root, "browser-profiles"))
    await writeFile(path.join(root, "browser-profiles/brw_test.tabs.json"), "foreign")
    await expect(store.ensure(r, r.plan.browsers)).rejects.toThrow("adopt")
    expect(await readFile(path.join(root, "browser-profiles/brw_test.tabs.json"), "utf8")).toBe("foreign")
  }))
test("does not reset changed saved links, manifests or opened profiles", () =>
  fixture(async (root, store, r, kv) => {
    await store.ensure(r, r.plan.browsers)
    await writeFile(path.join(root, "browser-profiles/brw_test.tabs.json"), "changed")
    await expect(store.ensure(r, r.plan.browsers)).rejects.toThrow("changed")
    expect(await readFile(path.join(root, "browser-profiles/brw_test.tabs.json"), "utf8")).toBe("changed")
    kv.set(Store.PREFIX + r.projectID, { foreign: true })
    await expect(store.ensure(r, r.plan.browsers)).rejects.toThrow("another import")
  }))
test("symlink stores are rejected before writing manifest or saved links", () =>
  fixture(async (root, store, r, kv) => {
    await mkdir(path.join(root, "outside"))
    await symlink(path.join(root, "outside"), path.join(root, "browser-profiles"))
    await expect(store.ensure(r, r.plan.browsers)).rejects.toThrow("links")
    expect(kv.size).toBe(0)
  }))
