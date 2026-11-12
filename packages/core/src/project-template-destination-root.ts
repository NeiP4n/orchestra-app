import { lstat } from "node:fs/promises"
import path from "node:path"
import { unlinkedPath } from "./project-template-path.js"
import { ProjectTemplateTransfer } from "./project-template-transfer.js"
/** A user-selected parent, never the project itself. Fresh child identity is still server-owned. */
export async function destinationRoot(input?: string) {
  const value = ProjectTemplateTransfer.normalizePath(input ?? "")
  if (!value) return undefined
  if (!path.isAbsolute(value)) throw Error("A verified model settings directory is required.")
  const root = path.resolve(value)
  let current = root
  for (;;) {
    try {
      const stat = await lstat(current)
      if (!stat.isDirectory()) throw Error("Project parent must be a directory.")
      if (stat.isSymbolicLink() || !(await unlinkedPath(current))) throw Error("Project directory must not use links.")
      return root
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      const parent = path.dirname(current)
      if (parent === current) throw error
      current = parent
    }
  }
}
