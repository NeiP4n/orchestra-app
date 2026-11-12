import { mkdtemp, open, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

/** Prompt text can contain private data. Never reuse a predictable shared-temp path. */
export async function createEditorFile(value: string) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "orchestra-editor-"))
  const file = path.join(directory, "prompt.md")
  const dispose = () => rm(directory, { recursive: true, force: true })
  try {
    const handle = await open(file, "wx", 0o600)
    try {
      await handle.writeFile(value, "utf8")
    } finally {
      await handle.close()
    }
    return { file, dispose }
  } catch (error) {
    await dispose()
    throw error
  }
}
