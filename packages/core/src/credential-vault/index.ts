export * as CredentialVault from "./index.js"
import { mkdir, readFile, open, rename, rm } from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { Flock } from "@orchestra/util/flock"
import { Global } from "@orchestra/util/global"
import { collector, type Collector } from "./windows.js"

interface Stored { version: 1; id: string; name: string; site: string; variables: { login: string; password: string }; backend: "windows-dpapi-user-v1"; blob: string }
export interface Name { id: string; name: string; variables: { login: string; password: string } }
const publicName = (entry: Stored): Name => ({ id: entry.id, name: entry.name, variables: { ...entry.variables } })
export const directory = () => path.join(Global.Path.data, "credential-vault")

export function make(options: { directory: string; collector: Collector }) {
  const file = path.join(options.directory, "registry.json")
  const load = async (): Promise<Stored[]> => {
    let text: string
    try { text = await readFile(file, "utf8") }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw new Error("Vault registry cannot be read; changes blocked.") }
    try {
      const entries = JSON.parse(text)
      if (!Array.isArray(entries) || entries.some((v) => v?.version !== 1 || typeof v.id !== "string" || typeof v.name !== "string" || typeof v.site !== "string" || typeof v.blob !== "string" || v.backend !== "windows-dpapi-user-v1" || !/^[A-Za-z0-9+/]+={0,2}$/.test(v.blob) || typeof v.variables?.login !== "string" || typeof v.variables?.password !== "string")) throw new Error()
      return entries
    } catch { throw new Error("Vault registry is damaged; changes blocked.") }
  }
  const save = async (entries: Stored[]) => {
    await mkdir(options.directory, { recursive: true, mode: 0o700 })
    const temp = `${file}.${randomUUID()}.tmp`
    try {
      const handle = await open(temp, "wx", 0o600)
      try { await handle.writeFile(JSON.stringify(entries)); await handle.sync() } finally { await handle.close() }
      await rename(temp, file)
    } catch { throw new Error("Vault registry could not be saved.") }
    finally { await rm(temp, { force: true }).catch(() => undefined) }
  }
  const lock = <T>(action: () => Promise<T>) => Flock.withLock(file, action, { dir: path.join(options.directory, "locks") })
  return {
    list: async (): Promise<Array<Pick<Name, "id" | "name">>> => (await load()).map(({ id, name }) => ({ id, name })),
    // Operator UI only. No model tool, no plaintext argument and no decrypt/get API.
    writeFromOperator: async (id?: string): Promise<Name | undefined> => {
      const previous = id === undefined ? undefined : (await load()).find((entry) => entry.id === id)
      if (id && !previous) throw new Error("Vault entry no longer exists.")
      const sealed = await options.collector.collect(previous && { name: previous.name, site: previous.site })
      if (!sealed) return undefined
      const name = sealed.name.trim()
      if (!name || name.length > 80 || /[\x00-\x1f\x7f]/.test(name) || sealed.site.length > 512 || sealed.backend !== "windows-dpapi-user-v1" || !/^[A-Za-z0-9+/]+={0,2}$/.test(sealed.blob)) throw new Error("Vault secure input is invalid.")
      return lock(async () => {
        const entries = await load()
        const current = id ? entries.find((entry) => entry.id === id) : undefined
        if (id && !current) throw new Error("Vault entry no longer exists.")
        if (entries.some((entry) => entry.id !== id && entry.name.toLowerCase() === name.toLowerCase())) throw new Error("Vault name already exists.")
        // ASCII safe prefix plus stable random suffix avoids Unicode/case collisions.
        const entryID = current?.id ?? randomUUID()
        const prefix = `ORCH_SECRET_${name.toUpperCase().replace(/[^A-Z0-9]+/g, "_").slice(0, 24) || "ENTRY"}_${entryID.replace(/-/g, "").slice(0, 12).toUpperCase()}`
        const entry: Stored = { version: 1, id: entryID, name, site: sealed.site, variables: current?.variables ?? { login: `${prefix}_LOGIN`, password: `${prefix}_PASSWORD` }, backend: sealed.backend, blob: sealed.blob }
        await save([...entries.filter((row) => row.id !== entryID), entry])
        return publicName(entry)
      })
    },
    deleteFromOperator: async (id: string, confirmed: boolean) => {
      if (!confirmed) throw new Error("Vault deletion requires operator confirmation.")
      await lock(async () => { const entries = await load(); await save(entries.filter((entry) => entry.id !== id)) })
    },
  }
}
export const local = () => make({ directory: directory(), collector: collector() })
