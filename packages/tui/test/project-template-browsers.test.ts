import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { createStorage } from "../src/context/storage"
import { ensureImportedBrowsers } from "../src/util/project-template-browsers"
import { emptyBrowserSessions } from "../src/util/browser-sessions"
const input = {
  importID: "pti_test",
  projectID: "prj_test",
  createdAt: 1,
  browsers: [{ id: "brw_test", name: "Inbox", chat: "ses_test", mode: "window" as const }],
}
test("atomic definition import keeps IDs, creates no selection, and does not reset user edits on retry", () => {
  const state = emptyBrowserSessions()
  ensureImportedBrowsers(state, input)
  expect(state.projects.prj_test[0]).toMatchObject({
    id: "brw_test",
    chat: "ses_test",
    mode: "window",
    templateImportID: "pti_test",
  })
  expect(state.selected.prj_test).toBeUndefined()
  state.projects.prj_test[0].name = "My renamed browser"
  ensureImportedBrowsers(state, input)
  expect(state.projects.prj_test[0].name).toBe("My renamed browser")
})
test("foreign project/browser/chat and changed import owner all fail instead of adopting or replacing", () => {
  for (const mutate of [
    (state: ReturnType<typeof emptyBrowserSessions>) => {
      state.projects.prj_test = [{ id: "brw_foreign", name: "Foreign", created: 0 }]
    },
    (state: ReturnType<typeof emptyBrowserSessions>) => {
      state.projects.prj_other = [{ id: "brw_test", name: "Foreign", created: 0 }]
    },
    (state: ReturnType<typeof emptyBrowserSessions>) => {
      state.retiredChats = { prj_other: ["ses_test"] }
    },
    (state: ReturnType<typeof emptyBrowserSessions>) => {
      state.templateImports = { prj_test: "pti_other" }
    },
  ]) {
    const state = emptyBrowserSessions()
    mutate(state)
    const before = JSON.stringify(state)
    expect(() => ensureImportedBrowsers(state, input)).toThrow()
    expect(JSON.stringify(state)).toBe(before)
  }
})
test("actual owning storage persists definitions; unreadable/corrupt disk is a failure, not a successful import", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "template-browser-ui-"))
  let dispose!: () => void
  try {
    const result = createStorage(root, "local")
    dispose = result.close
    const storage = result.storage
    const [state, update] = storage.store("browser-sessions", { initial: emptyBrowserSessions() })
    await update((draft) => ensureImportedBrowsers(draft, input))
    await storage.flush()
    const file = path.join(root, "local/tui/browser-sessions.json")
    expect(JSON.parse(await readFile(file, "utf8")).projects.prj_test[0].id).toBe("brw_test")
    expect(state.templateImports?.prj_test).toBe("pti_test")
    await writeFile(file, "damaged")
    await expect(
      update((draft) => ensureImportedBrowsers(draft, { ...input, projectID: "prj_new", importID: "pti_new" })),
    ).rejects.toThrow()
    expect(await readFile(file, "utf8")).toBe("damaged")
  } finally {
    dispose?.()
    await rm(root, { recursive: true, force: true })
  }
})
