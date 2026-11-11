export * as ProjectTemplateTransfer from "./project-template-transfer.js"

import { constants } from "node:fs"
import { lstat, open, readdir, realpath } from "node:fs/promises"
import path from "node:path"
import { unlinkedPath } from "./project-template-path.js"
import { ProjectTemplate as V1 } from "./project-template.js"
import { ProjectTemplateV2 as V2 } from "./project-template-v2.js"

export function preview(serialized: string) {
  const process = V2.preview(serialized)
  if (process.ok) return process.value
  const legacy = V1.preview(serialized)
  if (!legacy.ok) throw Error("Invalid portable template file. Nothing was imported.")
  return legacy.value
}
export async function read(file: string) {
  if (!path.isAbsolute(file) || !file.endsWith(".orchestra-template") || !(await unlinkedPath(file))) throw Error("Choose a regular .orchestra-template file.")
  const named = await lstat(file)
  if (!named.isFile() || named.nlink !== 1 || named.size > V2.MAX_BYTES) throw Error("Template file is not a bounded regular file.")
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const stat = await handle.stat()
    if (stat.ino !== named.ino || stat.dev !== named.dev || stat.size !== named.size) throw Error("Template changed while opening.")
    const bytes = Buffer.alloc(V2.MAX_BYTES + 1)
    let size = 0
    while (size < bytes.length) {
      const n = await handle.read(bytes, size, bytes.length - size, size)
      if (!n.bytesRead) break
      size += n.bytesRead
    }
    const after = await handle.stat(), current = await lstat(file)
    if (size !== stat.size || size > V2.MAX_BYTES || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs || current.ino !== stat.ino || current.dev !== stat.dev || !(await unlinkedPath(file))) throw Error("Template changed during review.")
    return preview(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size)))
  } finally { await handle.close() }
}
/** Writes one configuration file only. Never overwrites user files or changes git rules. */
export async function write(directory: string, serialized: string) {
  const value = preview(serialized)
  if (!path.isAbsolute(directory) || !(await unlinkedPath(directory))) throw Error("Project directory must not use links.")
  const root = await realpath(directory), info = await lstat(root)
  if (!info.isDirectory()) throw Error("Project directory is unavailable.")
  const name = value.bundle.name.normalize("NFKC").replace(/[^\p{L}\p{N}_-]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "project"
  const entries = new Set(await readdir(root))
  let destination = ""
  for (let n = 0; n < 1000; n++) {
    const candidate = name + (n ? "-" + (n + 1) : "") + ".orchestra-template"
    if (entries.has(candidate)) continue
    const target = path.join(root, candidate)
    let handle
    try { handle = await open(target, "wx", 0o600) } catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") continue; throw error }
    try { await handle.writeFile(value.text, "utf8"); await handle.sync() } finally { await handle.close() }
    destination = target
    break
  }
  if (!destination) throw Error("Template export name limit reached. No file was replaced.")
  const verified = await read(destination)
  if (verified.digest !== value.digest) throw Error("Export failed verification.")
  return { path: destination, warning: "Do not commit this configuration file to git. Review it before sharing; chats and secret values are excluded." }
}
