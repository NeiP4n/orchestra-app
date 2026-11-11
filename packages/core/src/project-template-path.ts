import { lstat, realpath } from "node:fs/promises"
import path from "node:path"

/** Check every named component, not its spelling against realpath. Windows may expand
 * an ordinary 8.3 name or change drive/ancestor casing without traversing any link.
 * Checking ancestors keeps symlink/junction escapes forbidden on every platform. */
export async function unlinkedPath(value: string) {
  if (!path.isAbsolute(value)) return false
  let current = path.resolve(value)
  for (;;) {
    const info = await lstat(current)
    if (info.isSymbolicLink()) return false
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  // Keep an existence/canonicalization check too; callers retain their descriptor,
  // inode, size and post-read checks for the file they actually opened.
  await realpath(value)
  return true
}
