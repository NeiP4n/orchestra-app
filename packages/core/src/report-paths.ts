export * as ReportPaths from "./report-paths.js"
import path from "node:path"
import { realpath, stat } from "node:fs/promises"

/** Only explicit project-relative code references, never URLs or arbitrary absolute paths. */
export const pathsOf = (text: string) => [...new Set([...text.matchAll(/`((?:packages|src|test|tests|script|scripts|docs)\/[\w./-]+\.[\w-]+)(?::\d+(?::\d+)?)?`/g)].map(match => match[1]!))]
export async function inspect(directory: string, text: string) {
  const root = await realpath(directory)
  const rows: { path: string; status: "exists" | "missing" | "outside" | "unverified" }[] = []
  for (const file of pathsOf(text)) {
    const absolute = path.resolve(root, file)
    if (path.relative(root, absolute).startsWith("..") || path.isAbsolute(path.relative(root, absolute))) { rows.push({path:file,status:"outside"}); continue }
    try {
      const actual = await realpath(absolute)
      const relative = path.relative(root, actual)
      if (relative.startsWith("..") || path.isAbsolute(relative)) { rows.push({path:file,status:"outside"}); continue }
      rows.push({path:file,status:(await stat(actual)).isFile() ? "exists" : "unverified"})
    } catch(error) { rows.push({path:file,status:(error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unverified"}) }
  }
  return rows
}
export const note = (rows: Awaited<ReturnType<typeof inspect>>) => rows.length ?
  "System path check (existence only, not correctness):\n" + rows.map(row=>`- ${row.path}: ${row.status}`).join("\n") +
  "\nMissing/unverified paths are not existing code. Correct the reference or explicitly plan a new file before dispatching edits. Signatures and code suggestions still need review against the actual files." : ""
