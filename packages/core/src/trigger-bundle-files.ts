export * as TriggerBundleFiles from "./trigger-bundle-files.js"

import { constants } from "node:fs"
import { lstat, mkdir, open, realpath, rm } from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { TriggerBundle } from "./trigger-bundle.js"

/** Project-local portable templates only. Saving/loading never registers or enables a trigger. */
async function folder(projectDirectory: string) {
  if (!path.isAbsolute(projectDirectory)) throw new Error("Select an absolute project directory.")
  const root = await realpath(projectDirectory)
  let current = root
  for (const part of [".orchestra", "triggers"]) {
    current = path.join(current, part)
    await mkdir(current, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error
    })
    const info = await lstat(current)
    if (info.isSymbolicLink() || !info.isDirectory() || (await realpath(current)) !== current)
      throw new Error("Trigger template folder must be a real directory in the selected project.")
  }
  return current
}
function filename(name: string) {
  if (!/^[a-z][a-z0-9_-]{0,59}$/.test(name)) throw new Error("Template name must be a simple lowercase file name.")
  return `${name}.json`
}
export async function save(projectDirectory: string, name: string, text: string) {
  const leaf = filename(name)
  const parsed = TriggerBundle.parse(text)
  if (!parsed.ok) throw new Error(parsed.error)
  const directory = await folder(projectDirectory)
  const target = path.join(directory, leaf)
  // Create-only: saving can never overwrite an existing or hostile template.
  const temporary = path.join(directory, `.${leaf}.${randomUUID()}.tmp`)
  try {
    const handle = await open(temporary, "wx", 0o600)
    try {
      await handle.writeFile(JSON.stringify(parsed.value, null, 2) + "\n", "utf8")
      await handle.sync()
    } finally {
      await handle.close()
    }
    // Hard link gives atomic create-if-absent, unlike rename which replaces existing files.
    const { link } = await import("node:fs/promises")
    await link(temporary, target)
  } finally {
    await rm(temporary, { force: true })
  }
  return target
}
export async function load(projectDirectory: string, name: string) {
  const leaf = filename(name)
  const directory = await folder(projectDirectory)
  const target = path.join(directory, leaf)
  const info = await lstat(target)
  if (info.isSymbolicLink() || !info.isFile()) throw new Error("Trigger template must be a regular file.")
  const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const actual = await handle.stat()
    if (!actual.isFile() || actual.size > TriggerBundle.MAX_BYTES || actual.ino !== info.ino || actual.dev !== info.dev)
      throw new Error("Trigger template changed or is too large.")
    const bytes = Buffer.alloc(TriggerBundle.MAX_BYTES + 1)
    const read = await handle.read(bytes, 0, bytes.length, 0)
    if (read.bytesRead > TriggerBundle.MAX_BYTES) throw new Error("Trigger template is too large.")
    const parsed = TriggerBundle.parse(bytes.subarray(0, read.bytesRead).toString("utf8"))
    if (!parsed.ok) throw new Error(parsed.error)
    return parsed.value
  } finally {
    await handle.close()
  }
}
