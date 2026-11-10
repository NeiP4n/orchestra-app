export * as ProjectTemplateBrowserStore from "./project-template-browser-store.js"

import { constants } from "node:fs"
import { lstat, mkdir, open, readdir, realpath } from "node:fs/promises"
import path from "node:path"
import { isDeepStrictEqual } from "node:util"
import { Effect } from "effect"
import type { KV } from "./kv.js"
import type { ProjectTemplateMaterialize as M } from "./project-template-materialize.js"

export const PREFIX = "orchestra/template-browsers/"
const serial = (v: unknown): KV.Value => JSON.parse(JSON.stringify(v))
const absent = async (file: string) => {
  try {
    await lstat(file)
    return false
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true
    throw error
  }
}
async function folder(root: string) {
  if (!path.isAbsolute(root)) throw Error("Browser configuration root must be absolute.")
  const stat = await lstat(root)
  if (!stat.isDirectory() || stat.isSymbolicLink() || (await realpath(root)) !== path.resolve(root))
    throw Error("Browser configuration root cannot use links.")
  const directory = path.join(root, "browser-profiles")
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const info = await lstat(directory)
  if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(directory)) !== directory)
    throw Error("Browser configuration store cannot use links.")
  return directory
}
async function exactFile(file: string, text: string) {
  const info = await lstat(file)
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 262144)
    throw Error("Saved links require an unchanged bounded regular file.")
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const stat = await handle.stat()
    if (stat.ino !== info.ino || stat.dev !== info.dev || (await handle.readFile("utf8")) !== text)
      throw Error("Saved links changed since import.")
  } finally {
    await handle.close()
  }
}
/** Destination-owned definitions + runtime-compatible saved-link files. Never launches Chrome,
 * reads a profile, imports cookies, or grants a BrowserAgent permission. All profiles remain absent.
 * Definitions retain every saved link even though the current runtime restores only eight tabs. */
export function make(kv: KV.Interface, dataDirectory: string) {
  const read = (key: string) => Effect.runPromise(kv.get(key))
  const manifest = (r: M.Receipt, rows: M.Plan["browsers"]) => ({
    version: 1,
    importID: r.id,
    projectID: r.projectID,
    createdAt: r.createdAt,
    browsers: rows,
  })
  const fileText = (row: M.Plan["browsers"][number]) => JSON.stringify({ tabs: row.savedLinks.map((url) => ({ url })) })
  const definitions = (r: M.Receipt, rows: M.Plan["browsers"]) =>
    rows.map((row) => ({ id: row.id, name: row.name, projectID: r.projectID, chat: row.chat, mode: row.mode }))
  const validate = async (r: M.Receipt, rows: M.Plan["browsers"]) => {
    // Reuse source ID/ownership and URL validation with a pure unopened fixture, not a runtime read.
    if (new Set(rows.map((row) => row.id)).size !== rows.length) throw Error("Duplicate browser identities.")
    for (const row of rows) {
      if (
        row.state !== "not-opened" ||
        row.profile !== "new" ||
        row.login !== "required" ||
        row.savedLinks.length > 100
      )
        throw Error("Invalid unopened browser definition.")
      for (const url of row.savedLinks) {
        const parsed = new URL(url)
        if (
          !["https:", "http:"].includes(parsed.protocol) ||
          parsed.search ||
          parsed.hash ||
          parsed.username ||
          parsed.password
        )
          throw Error("Nonportable saved link.")
      }
    }
    if (definitions(r, rows).some((row) => !/^brw_[A-Za-z0-9_-]{1,100}$/.test(row.id) || !row.name.trim()))
      throw Error("Invalid browser identity.")
  }
  const verify = async (r: M.Receipt, rows: M.Plan["browsers"]) => {
    await validate(r, rows)
    if (!isDeepStrictEqual(await read(PREFIX + r.projectID), serial(manifest(r, rows))))
      throw Error("Browser definition owner differs.")
    const directory = await folder(dataDirectory)
    for (const row of rows) {
      if (!(await absent(path.join(directory, row.id)))) throw Error("Imported browser profile already exists.")
      await exactFile(path.join(directory, row.id + ".tabs.json"), fileText(row))
    }
  }
  return {
    ensure: async (r: M.Receipt, rows: M.Plan["browsers"]) => {
      await validate(r, rows)
      const directory = await folder(dataDirectory),
        expected = serial(manifest(r, rows)),
        current = await read(PREFIX + r.projectID)
      if (current === undefined) {
        const files = await readdir(directory)
        if (rows.some((row) => files.some((file) => file === row.id || file.startsWith(row.id + "."))))
          throw Error("Cannot adopt an existing browser identity or profile.")
      }
      await Effect.runPromise(
        kv.atomicUpdate(PREFIX + r.projectID, (value) => {
          if (value !== undefined && !isDeepStrictEqual(value, expected))
            throw Error("Browser definitions changed or belong to another import.")
          return expected
        }),
      )
      for (const row of rows) {
        const file = path.join(directory, row.id + ".tabs.json")
        try {
          const handle = await open(file, "wx", 0o600)
          try {
            await handle.writeFile(fileText(row))
            await handle.sync()
          } finally {
            await handle.close()
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
        }
        await exactFile(file, fileText(row))
      }
      await verify(r, rows)
    },
    verify,
    read: async (projectID: string) => read(PREFIX + projectID),
  }
}
