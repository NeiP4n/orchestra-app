export * as ShellSourceFile from "./source-file.js"

import { mkdtemp, open, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

/** A command can contain secrets. Keep parser input in a private directory,
 * created exclusively rather than following an existing file or link. */
export async function create(command: string) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "orchestra-nu-check-"))
  const file = path.join(directory, "source.nu")
  const dispose = () => rm(directory, { recursive: true, force: true })
  try {
    const handle = await open(file, "wx", 0o600)
    try {
      await handle.writeFile(command, "utf8")
    } finally {
      await handle.close()
    }
    return { file, dispose }
  } catch (error) {
    await dispose()
    throw error
  }
}
