export * as ProjectTemplateBrowser from "./project-template-browser.js"

import { createHash } from "node:crypto"
import { ProjectTemplateLinkReview as LinkReview } from "./project-template-link-review.js"
import { constants } from "node:fs"
import { lstat, open, realpath } from "node:fs/promises"
import path from "node:path"
import { ProjectTemplateSource } from "./project-template-source.js"

/** Explicit metadata only, from the owning Browser UI store. Closed/retired sessions are not passed.
 * Browser mode is a portable preference, not an in-memory live Chrome lookup. */
export interface Definition {
  id: string
  name: string
  projectID: string
  chat?: string
  mode?: "headless" | "window" | "capture"
}
async function realDirectory(directory: string) {
  const info = await lstat(directory)
  if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(directory)) !== path.resolve(directory))
    throw Error("Saved browser configuration cannot use linked directories.")
}

/** Reads only each explicitly named .tabs.json. No BrowserRuntime/Chrome/DOM/profile reader.
 * Fails rather than dropping unsafe links or silently limiting the saved list to eight tabs.
 * Default window mode is deliberate for a fresh unopened destination, not a claim about current Chrome. */
export interface Review { issues: LinkReview.Issue[]; fingerprint: string }
export async function capture(dataDirectory: string, projectID: string, definitions: readonly Definition[], review?: Review) {
  const fingerprint = createHash("sha256")
  if (review) { review.issues = []; review.fingerprint = "" }
  if (
    !path.isAbsolute(dataDirectory) ||
    !projectID ||
    definitions.length > 50 ||
    new Set(definitions.map((row) => row.id)).size !== definitions.length
  )
    throw Error("Invalid browser template source.")
  await realDirectory(dataDirectory)
  const directory = path.join(dataDirectory, "browser-profiles")
  try {
    await realDirectory(directory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    // A profile store that has never existed is a legitimate list of unopened sessions.
    return definitions.map((row) => project(row, projectID, []))
  }
  const result: ProjectTemplateSource.Source["browsers"][number][] = []
  for (const [browserIndex, row] of definitions.entries()) {
    const base = project(row, projectID, [])
    const file = path.join(directory, `${row.id}.tabs.json`)
    const before = await lstat(file).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
      throw error
    })
    if (!before) {
      result.push(base)
      continue
    }
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 262144)
      throw Error("Saved links require a bounded regular file.")
    const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const info = await handle.stat()
      if (
        !info.isFile() ||
        info.nlink !== 1 ||
        info.dev !== before.dev ||
        info.ino !== before.ino ||
        info.size > 262144
      )
        throw Error("Saved link file changed.")
      const buffer = Buffer.alloc(262145),
        read = await handle.read(buffer, 0, buffer.length, 0)
      if (read.bytesRead > 262144) throw Error("Saved links exceed the transfer limit.")
      const raw: unknown = JSON.parse(buffer.subarray(0, read.bytesRead).toString("utf8"))
      const tabs = Array.isArray(raw) ? raw : raw && typeof raw === "object" && "tabs" in raw ? raw.tabs : undefined
      if (!Array.isArray(tabs) || tabs.length > 100)
        throw Error("Saved link list is damaged or exceeds the transfer limit.")
      const links = tabs.flatMap((entry: unknown, linkIndex: number) => {
        const url =
          typeof entry === "string"
            ? entry
            : entry && typeof entry === "object" && "url" in entry
              ? entry.url
              : undefined
        if (typeof url !== "string") throw Error("Saved link list is damaged.")
        fingerprint.update(JSON.stringify([browserIndex, linkIndex, url]))
        const reason = LinkReview.reason(url)
        if (reason) {
          if (!review) throw Error("Saved links contain nonportable parameters. Review before saving.")
          review.issues.push({ browser: browserIndex + 1, link: linkIndex + 1, reason })
          return []
        }
        return [url]
      })
      // All remaining source scanning and slot reference checks belong to ProjectTemplateSource.capture.
      result.push({ ...base, savedLinks: links })
    } finally {
      await handle.close()
    }
  }
  await realDirectory(directory)
  if (review) review.fingerprint = fingerprint.digest("hex")
  return result
}
function project(row: Definition, projectID: string, savedLinks: readonly string[]) {
  if (
    row.projectID !== projectID ||
    !/^brw_[A-Za-z0-9_-]{1,100}$/.test(row.id) ||
    !row.name.trim() ||
    (row.mode && !["headless", "window", "capture"].includes(row.mode))
  )
    throw Error("Browser ownership or identity is invalid.")
  return {
    id: row.id,
    name: row.name,
    projectID,
    mode: row.mode ?? ("window" as const),
    savedLinks,
    ...(row.chat ? { chat: row.chat } : {}),
  }
}
