export * as ProjectTemplateV2Library from "./project-template-v2-library.js"
import { lstat, mkdir, readdir, realpath } from "node:fs/promises"
import path from "node:path"
import { ProjectTemplateV2 as V2 } from "./project-template-v2.js"
import { ProjectTemplateFiles as Files } from "./project-template-files.js"
/** Explicit process library until the main operator's live v2 installer is available.
 * Never pass v2 through the v1 materializer, nor advertise a stored document as an installed process. */
export function local(dataDirectory: string) {
  const name = (value: string) => { if (!/^[a-z][a-z0-9_-]{0,59}$/.test(value)) throw Error("Select a simple process template name."); V2.relativePath(value); return value }
  const folder = async () => {
    if (!path.isAbsolute(dataDirectory)) throw Error("Absolute application data directory required.")
    const parent = path.resolve(dataDirectory), stat = await lstat(parent)
    if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(parent) !== parent) throw Error("Process library must not use links.")
    const root = path.join(parent, "process-templates")
    await mkdir(root, { recursive: true, mode: 0o700 })
    const info = await lstat(root)
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(root) !== root) throw Error("Process library must not use links.")
    return root
  }
  const preview = async (id: string) => Files.loadWithCodec(path.join(await folder(), name(id)), V2)
  return {
    preview,
    saveSerialized: async (serialized: string, id: string, reviewedDigest: string) => Files.saveWithCodec(await folder(), name(id), serialized, reviewedDigest, V2),
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
