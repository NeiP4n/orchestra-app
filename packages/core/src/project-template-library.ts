export * as ProjectTemplateLibrary from "./project-template-library.js"

import { lstat, mkdir, readdir, realpath } from "node:fs/promises"
import path from "node:path"
import { Global } from "@orchestra/util/global"
import { ProjectTemplateFiles } from "./project-template-files.js"

export interface Entry {
  name: string
  state: "ready" | "invalid"
  title?: string
  digest?: string
}
function simple(value: string) {
  if (!/^[a-z][a-z0-9_-]{0,59}$/.test(value)) throw Error("Select a simple lowercase template name.")
  return value
}

/** Local operator library. New revisions need new names; no overwrite, delete, execute or automatic update. */
export function local(parentDirectory = Global.Path.data) {
  async function folder() {
    if (!path.isAbsolute(parentDirectory))
      throw Error("Template library requires an absolute application data directory.")
    const parent = await realpath(parentDirectory),
      info = await lstat(parentDirectory)
    if (!info.isDirectory() || info.isSymbolicLink() || path.resolve(parentDirectory) !== parent)
      throw Error("Template library directory cannot use links.")
    const directory = path.join(parent, "project-templates")
    try {
      await mkdir(directory, { mode: 0o700 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    }
    const current = await lstat(directory)
    if (!current.isDirectory() || current.isSymbolicLink() || (await realpath(directory)) !== directory)
      throw Error("Template library directory cannot use links.")
    return directory
  }
  const source = async (name: string) => path.join(await folder(), simple(name))
  const verified = async (name: string, digest: string) => {
    const directory = await source(name),
      preview = await ProjectTemplateFiles.load(directory)
    if (preview.digest !== digest) throw Error("Template changed after preview. Review it again.")
    return { directory, preview }
  }
  return {
    list: async (): Promise<Entry[]> => {
      const directory = await folder(),
        names = await readdir(directory)
      if (names.length > 200) throw Error("Template library exceeds 200 entries. Review its directory manually.")
      const entries: Entry[] = []
      for (const name of names.sort()) {
        if (!/^[a-z][a-z0-9_-]{0,59}$/.test(name)) continue
        try {
          const preview = await ProjectTemplateFiles.load(path.join(directory, name))
          entries.push({ name, state: "ready", title: preview.bundle.name, digest: preview.digest })
        } catch {
          entries.push({ name, state: "invalid" })
        }
      }
      return entries
    },
    preview: async (name: string) => ProjectTemplateFiles.load(await source(name)),
    remember: async (sourceDirectory: string, name: string, reviewedDigest: string) => {
      const preview = await ProjectTemplateFiles.load(sourceDirectory)
      if (preview.digest !== reviewedDigest) throw Error("Template changed after preview. Review it again.")
      return ProjectTemplateFiles.save(await folder(), simple(name), preview.text, reviewedDigest)
    },
    export: async (name: string, destination: string, newName: string, reviewedDigest: string) => {
      const { preview } = await verified(name, reviewedDigest)
      return ProjectTemplateFiles.save(destination, simple(newName), preview.text, reviewedDigest)
    },
    stage: async (
      name: string,
      projectDirectory: string,
      newName: string,
      reviewedDigest: string,
      installedVersion: string,
    ) => {
      const { directory } = await verified(name, reviewedDigest)
      return ProjectTemplateFiles.stage(directory, projectDirectory, simple(newName), reviewedDigest, installedVersion)
    },
  }
}
