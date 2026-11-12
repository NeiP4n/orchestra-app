export * as ProjectTemplateV2Library from "./project-template-v2-library.js"

import { TemplateStageError } from "./project-template-errors.js"
import { unlinkedPath } from "./project-template-path.js"
import { lstat, mkdir, readdir } from "node:fs/promises"
import path from "node:path"
import { ProjectTemplateV2 as V2 } from "./project-template-v2.js"
import { ProjectTemplateFiles as Files } from "./project-template-files.js"
/** Self-contained process library used by the v2 operator and portable export/import.
 * Stored documents are not installed processes; activation belongs to the reviewed live installer. */
export function local(dataDirectory: string) {
  const name = (value: string) => { if (!/^[a-z][a-z0-9_-]{0,59}$/.test(value)) throw new TemplateStageError("template-name", new Error("Invalid template library name"), "name-invalid"); V2.relativePath(value); return value }
  const folder = async () => {
    if (!path.isAbsolute(dataDirectory)) throw Error("Absolute application data directory required.")
    const parent = path.resolve(dataDirectory), stat = await lstat(parent)
    if (!stat.isDirectory() || stat.isSymbolicLink() || !(await unlinkedPath(parent))) throw Error("Process library must not use links.")
    const root = path.join(parent, "process-templates")
    await mkdir(root, { recursive: true, mode: 0o700 })
    const info = await lstat(root)
    if (!info.isDirectory() || info.isSymbolicLink() || !(await unlinkedPath(root))) throw Error("Process library must not use links.")
    return root
  }
  const preview = async (id: string) => Files.loadWithCodec(path.join(await folder(), name(id)), V2)
  return {
    preview,
    saveSerialized: async (serialized: string, id: string, reviewedDigest: string) => Files.saveWithCodec(await folder(), name(id), serialized, reviewedDigest, V2),
    replaceSerialized: async (serialized: string, id: string, previousDigest: string, reviewedDigest: string) => Files.replaceWithCodec(path.join(await folder(), name(id)), serialized, previousDigest, reviewedDigest, V2),
    remember: async (source: string, id: string, reviewedDigest: string) => {
      const p = await Files.loadWithCodec(source, V2)
      if (p.digest !== reviewedDigest) throw Error("Process template changed after review.")
      return Files.saveWithCodec(await folder(), name(id), p.text, reviewedDigest, V2)
    },
    export: async (id: string, target: string, newName: string, reviewedDigest: string) => {
      const p = await preview(id)
      if (p.digest !== reviewedDigest) throw Error("Process template changed after review.")
      return Files.saveWithCodec(target, name(newName), p.text, reviewedDigest, V2)
    },
    list: async () => {
      const root = await folder(), entries = await readdir(root)
      if (entries.length > 200) throw Error("Process library exceeds the entry limit.")
      const result: { id: string; state: "ready" | "invalid"; name?: string; digest?: string; version?: 2 }[] = []
      for (const id of entries.sort()) {
        if (!/^[a-z][a-z0-9_-]{0,59}$/.test(id)) continue
        try { const p = await preview(id); result.push({ id, state: "ready", name: p.bundle.name, digest: p.digest, version: 2 }) }
        catch { result.push({ id, state: "invalid" }) }
      }
      return result
    },
  }
}
