import { expect, test } from "bun:test"
import { readFile, stat } from "node:fs/promises"
import path from "node:path"
import { createEditorFile } from "../src/editor-file"

test("prompt files are exclusively created in separate private directories and removed", async () => {
  const first = await createEditorFile("private first prompt")
  const second = await createEditorFile("private second prompt")
  try {
    expect(path.dirname(first.file)).not.toBe(path.dirname(second.file))
    expect(await readFile(first.file, "utf8")).toBe("private first prompt")
    expect(await readFile(second.file, "utf8")).toBe("private second prompt")
    const directory = await stat(path.dirname(first.file))
    const file = await stat(first.file)
    expect(file.isFile()).toBe(true)
    expect(file.nlink).toBe(1)
    if (process.platform !== "win32") {
      expect(directory.mode & 0o777).toBe(0o700)
      expect(file.mode & 0o777).toBe(0o600)
    }
  } finally {
    await first.dispose()
    await second.dispose()
  }
  expect(await stat(path.dirname(first.file)).catch(() => undefined)).toBeUndefined()
  expect(await stat(path.dirname(second.file)).catch(() => undefined)).toBeUndefined()
})
