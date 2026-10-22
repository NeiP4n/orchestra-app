import { afterEach, expect, spyOn, test } from "bun:test"
import * as fs from "fs"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { createStorage } from "../../src/context/storage"
import * as fsPromises from "fs/promises"
import { writeJsonAtomic } from "../../src/util/persistence"

afterEach(() => {
  spyOn(fs, "watch").mockRestore()
})

test("writeJsonAtomic retries transient rename failures before replacing persisted state", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "storage-rename-"))
  const file = path.join(dir, "tabs.json")
  await Bun.write(file, JSON.stringify({ title: "old" }))
  const actualRename = fsPromises.rename
  let attempts = 0
  const renameSpy = spyOn(fsPromises, "rename").mockImplementation(async (source, destination) => {
    attempts++
    if (attempts < 3) {
      throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" })
    }
    return actualRename(source, destination)
  })

  try {
    await writeJsonAtomic(file, { title: "new" })
    expect(attempts).toBe(3)
    expect(await Bun.file(file).json()).toEqual({ title: "new" })
  } finally {
    renameSpy.mockRestore()
    rmSync(dir, { recursive: true, force: true })
  }
})

test("createStorage degrades gracefully when fs.watch throws (e.g. ENOSPC)", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "storage-test-"))
  // fs.watch throws synchronously when inotify_add_watch fails (e.g. the watch
  // limit is exhausted). Simulate that scoped to this test only.
  spyOn(fs, "watch").mockImplementation(() => {
    throw Object.assign(new Error("ENOSPC: no space left on device, watch '/some/dir'"), { code: "ENOSPC" })
  })

  try {
    let result: ReturnType<typeof createStorage> | undefined
    expect(() => {
      result = createStorage(dir, "next")
    }).not.toThrow()

    // storage should still be usable even though the live-reload watcher failed to attach
    const [store, update] = result!.storage.store("kv", { initial: { count: 0 } })
    expect(store.count).toBe(0)
    await update((draft) => {
      draft.count = 1
    })
    expect(store.count).toBe(1)
    expect(() => result!.close()).not.toThrow()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
