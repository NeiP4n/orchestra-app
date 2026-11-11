export * as CredentialVault from "./index.js"
import { mkdir, readFile, open, rename, rm, lstat } from "node:fs/promises"
import path from "node:path"
import { constants } from "node:fs"
import { countSecrets } from "../memory/scrub.js"
import { randomUUID } from "node:crypto"
import { Flock } from "@orchestra/util/flock"
import { Global } from "@orchestra/util/global"
import { allowedUrl, nativeHttp, httpSummary } from "./http.js"
import { VaultAccess } from "./access.js"
import { Ssrf } from "../tool/ssrf.js"
import { collector, type Collector, type WindowStatus } from "./windows.js"

export type ScopeKind = "global" | "project"
export interface SlotDefinition {
  name: string
  type: "login" | "api-key" | "password"
  label: string
}
export interface SlotInfo extends SlotDefinition {
  id: string
  scope: ScopeKind | "legacy"
  projectID?: string
  state: "empty" | "filled"
  allowedSessionIDs: string[]
}
interface Stored {
  templateImportID?: string
  scope?: ScopeKind
  empty?: boolean
  type?: SlotDefinition["type"]
  label?: string
  allowedSessionIDs?: string[]
  projectIDs?: string[]
  projectID?: string
  version: 1
  id: string
  name: string
  site: string
  variables: { login: string; password: string }
  backend: "windows-dpapi-user-v1"
  blob: string
}
export interface Name {
  id: string
  name: string
  variables: { login: string; password: string }
}
const publicName = (entry: Stored): Name => ({ id: entry.id, name: entry.name, variables: { ...entry.variables } })
export const directory = () => path.join(Global.Path.data, "credential-vault")

export function make(options: {
  directory: string
  collector: Collector
  projectID?: string
  request?: (blob: string, url: string) => Promise<{ status: number; durationMs: number }>
  checkUrl?: (url: string) => Promise<unknown>
}) {
  const file = path.join(options.directory, "registry.json")
  const visible = (entry: Stored) =>
    !options.projectID ||
    entry.scope === "global" ||
    entry.projectID === options.projectID ||
    (!entry.scope && entry.projectIDs?.includes(options.projectID))
  const sameScope = (entry: Stored, scope: ScopeKind | undefined, projectID?: string) =>
    entry.scope === scope && entry.projectID === projectID
  const validName = (name: string) =>
    !!name.trim() && name.length <= 80 && !/[\x00-\x1f\x7f]/.test(name) && countSecrets(name) === 0
  const validSessions = (values: string[]) =>
    values.length <= 100 &&
    new Set(values).size === values.length &&
    values.every((v) => /^ses_[A-Za-z0-9_-]{1,120}$/.test(v))
  const slotInfo = (entry: Stored): SlotInfo => ({
    id: entry.id,
    name: entry.name,
    type: entry.type ?? "login",
    label: entry.label ?? entry.name,
    scope: entry.scope ?? "legacy",
    ...(entry.projectID ? { projectID: entry.projectID } : {}),
    state: entry.empty ? "empty" : "filled",
    allowedSessionIDs: [...(entry.allowedSessionIDs ?? [])],
  })
  const load = async (): Promise<Stored[]> => {
    let text: string
    try {
      text = await readFile(file, "utf8")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
      throw new Error("Vault registry cannot be read; changes blocked.")
    }
    try {
      const entries = JSON.parse(text)
      if (
        !Array.isArray(entries) ||
        entries.some(
          (v) =>
            v?.version !== 1 ||
            (v.templateImportID !== undefined && !/^pti_[A-Za-z0-9_-]{1,100}$/.test(v.templateImportID)) ||
            (v.projectID !== undefined && typeof v.projectID !== "string") ||
            (v.projectIDs !== undefined &&
              (!Array.isArray(v.projectIDs) || v.projectIDs.some((id: unknown) => typeof id !== "string"))) ||
            typeof v.id !== "string" ||
            typeof v.name !== "string" ||
            typeof v.site !== "string" ||
            (v.scope !== undefined && v.scope !== "global" && v.scope !== "project") ||
            (v.scope === "project" && !v.projectID) ||
            (v.scope === "global" && (v.projectID || v.projectIDs?.length)) ||
            (v.empty !== undefined && typeof v.empty !== "boolean") ||
            (v.type !== undefined && !["login", "api-key", "password"].includes(v.type)) ||
            (v.label !== undefined && typeof v.label !== "string") ||
            (v.allowedSessionIDs !== undefined &&
              (!Array.isArray(v.allowedSessionIDs) || !validSessions(v.allowedSessionIDs))) ||
            typeof v.blob !== "string" ||
            v.backend !== "windows-dpapi-user-v1" ||
            (v.empty ? v.blob !== "" : !/^[A-Za-z0-9+/]+={0,2}$/.test(v.blob)) ||
            typeof v.variables?.login !== "string" ||
            typeof v.variables?.password !== "string",
        )
      )
        throw new Error()
      return entries
    } catch {
      throw new Error("Vault registry is damaged; changes blocked.")
    }
  }
  const save = async (entries: Stored[]) => {
    await mkdir(options.directory, { recursive: true, mode: 0o700 })
    const temp = `${file}.${randomUUID()}.tmp`
    try {
      const handle = await open(temp, "wx", 0o600)
      try {
        await handle.writeFile(JSON.stringify(entries))
        await handle.sync()
      } finally {
        await handle.close()
      }
      await rename(temp, file)
    } catch {
      throw new Error("Vault registry could not be saved.")
    } finally {
      await rm(temp, { force: true }).catch(() => undefined)
    }
  }
  const lock = <T>(action: () => Promise<T>) =>
    Flock.withLock(file, action, { dir: path.join(options.directory, "locks") })
  const auditFile = path.join(options.directory, "usage.jsonl")
  const audit = async (
    entry: Stored,
    scope: VaultAccess.Scope,
    outcome: "attempt" | "success" | "denied" | "failed",
  ) => {
    await lock(async () => {
      await mkdir(options.directory, { recursive: true, mode: 0o700 })
      const before = await lstat(auditFile).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error
        return undefined
      })
      if (before && (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1))
        throw Error("Vault audit must be a private regular file.")
      if (before && before.size > 1_000_000) await rename(auditFile, auditFile + ".1")
      const handle = await open(
        auditFile,
        constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
        0o600,
      )
      try {
        const info = await handle.stat()
        if (
          !info.isFile() ||
          info.nlink !== 1 ||
          (before && before.size <= 1_000_000 && (info.ino !== before.ino || info.dev !== before.dev))
        )
          throw Error("Vault audit changed unexpectedly.")
        await handle.writeFile(
          JSON.stringify({
            version: 1,
            at: Date.now(),
            slotID: entry.id,
            scope: entry.scope ?? "legacy",
            projectID: scope.projectID,
            sessionID: scope.sessionID,
            action: "fixed-http-models",
            outcome,
          }) + "\n",
        )
        await handle.sync()
      } finally {
        await handle.close()
      }
    })
  }
  return {
    slots: async (): Promise<SlotInfo[]> => (await load()).filter(visible).map(slotInfo),
    // Operator-owned template materialization: no secret input, no inherited agent grants.
    createEmptyLocalSlotsFromOperator: async (definitions: SlotDefinition[]) => {
      if (!options.projectID || definitions.length > 100) throw Error("Verified destination project required.")
      if (
        definitions.some(
          (v) =>
            Object.keys(v).sort().join(",") !== "label,name,type" ||
            !/^[a-z][a-z0-9_-]{0,39}$/.test(v.name) ||
            !validName(v.label) ||
            !["login", "api-key", "password"].includes(v.type),
        ) ||
        new Set(definitions.map((v) => v.name)).size !== definitions.length
      )
        throw Error("Invalid empty Vault slot definitions.")
      return lock(async () => {
        const entries = await load()
        if (
          definitions.some((v) =>
            entries.some((e) => e.projectID === options.projectID && e.name.toLowerCase() === v.name.toLowerCase()),
          )
        )
          throw Error("A project Vault slot already exists. Nothing was replaced.")
        const added: Stored[] = definitions.map((v) => {
          const id = randomUUID()
          return {
            ...v,
            scope: "project",
            projectID: options.projectID,
            empty: true,
            allowedSessionIDs: [],
            version: 1,
            id,
            site: "",
            variables: {
              login: `ORCH_SLOT_${id.replace(/-/g, "")}_LOGIN`,
              password: `ORCH_SLOT_${id.replace(/-/g, "")}_PASSWORD`,
            },
            backend: "windows-dpapi-user-v1",
            blob: "",
          }
        })
        await save([...entries, ...added])
        return added.map(slotInfo)
      })
    },
    // Import recovery primitive. Exact pre-reserved IDs, create-only, no ability to read or reset values/grants.
    ensureImportedEmptySlotsFromOperator: async (
      importID: string,
      definitions: (SlotDefinition & { id: string })[],
    ) => {
      if (
        !options.projectID ||
        !/^pti_[A-Za-z0-9_-]{1,100}$/.test(importID) ||
        definitions.length > 100 ||
        definitions.some(
          (v) =>
            Object.keys(v).sort().join(",") !== "id,label,name,type" ||
            !/^[A-Za-z0-9_-]{1,120}$/.test(v.id) ||
            !/^[a-z][a-z0-9_-]{0,39}$/.test(v.name) ||
            !validName(v.label) ||
            !["login", "api-key", "password"].includes(v.type),
        ) ||
        new Set(definitions.map((v) => v.id)).size !== definitions.length ||
        new Set(definitions.map((v) => v.name.toLowerCase())).size !== definitions.length
      )
        throw Error("Invalid import slot reservation.")
      return lock(async () => {
        const entries = await load(),
          added: Stored[] = []
        for (const definition of definitions) {
          const existing = entries.find((entry) => entry.id === definition.id)
          if (existing) {
            if (
              existing.templateImportID !== importID ||
              existing.scope !== "project" ||
              existing.projectID !== options.projectID ||
              !existing.empty ||
              existing.blob !== "" ||
              existing.name !== definition.name ||
              existing.type !== definition.type ||
              existing.label !== definition.label ||
              existing.allowedSessionIDs?.length
            )
              throw Error("Import slot changed or belongs to another operation.")
            continue
          }
          if (
            entries.some(
              (entry) =>
                entry.projectID === options.projectID && entry.name.toLowerCase() === definition.name.toLowerCase(),
            )
          )
            throw Error("Import cannot replace an existing Vault slot.")
          added.push({
            ...definition,
            templateImportID: importID,
            scope: "project",
            projectID: options.projectID,
            empty: true,
            allowedSessionIDs: [],
            version: 1,
            site: "",
            variables: { login: `ORCH_SLOT_${definition.id}_LOGIN`, password: `ORCH_SLOT_${definition.id}_PASSWORD` },
            backend: "windows-dpapi-user-v1",
            blob: "",
          })
        }
        if (added.length) await save([...entries, ...added])
        return definitions.map((definition) =>
          slotInfo([...entries, ...added].find((entry) => entry.id === definition.id)!),
        )
      })
    },
    setAllowedSessionsFromOperator: async (id: string, allowedSessionIDs: string[], confirmed: boolean) => {
      if (!confirmed || !validSessions(allowedSessionIDs))
        throw Error("An explicit valid operator session grant is required.")
      await lock(async () => {
        const entries = await load(),
          entry = entries.find((v) => v.id === id && visible(v))
        if (!entry) throw Error("Vault slot is unavailable.")
        entry.allowedSessionIDs = [...allowedSessionIDs]
        await save(entries)
      })
    },
    removeProjectSlots: async (projectID: string) => {
      if (!projectID || (options.projectID && options.projectID !== projectID)) throw Error("Vault project mismatch")
      await lock(async () => {
        const entries = await load()
        await save(
          entries.flatMap((entry) => {
            if (entry.scope === "global") return [entry]
            if (entry.scope === "project") return entry.projectID === projectID ? [] : [entry]
            // Preserve legacy bindings to other projects without silently upgrading them to global.
            const bindings = [
              ...new Set(
                [entry.projectID, ...(entry.projectIDs ?? [])].filter((id): id is string => !!id && id !== projectID),
              ),
            ]
            if (entry.projectID === projectID || entry.projectIDs?.includes(projectID))
              return bindings.length ? [{ ...entry, projectID: bindings[0], projectIDs: bindings.slice(1) }] : []
            return [entry]
          }),
        )
      })
    },
    list: async (): Promise<Array<Pick<Name, "id" | "name">>> =>
      (await load()).filter(visible).map(({ id, name }) => ({ id, name })),
    // Operator UI only. No model tool, no plaintext argument and no decrypt/get API.
    writeFromOperator: async (
      id?: string,
      signal?: AbortSignal,
      onReady?: (status?: WindowStatus) => void,
      initial?: { name: string; site: string; scope?: ScopeKind },
    ): Promise<Name | undefined> => {
      const previous = id === undefined ? undefined : (await load()).find((entry) => entry.id === id && visible(entry))
      if (id && !previous) throw new Error("Vault entry no longer exists.")
      const requestedScope = previous?.scope ?? initial?.scope
      if (requestedScope === "project" && !options.projectID) throw Error("Select a project for a local Vault slot.")
      if (previous && initial?.scope && previous.scope !== initial.scope)
        throw Error("Editing cannot change a Vault slot scope.")
      const sealed = await options.collector.collect(
        previous ? { name: previous.name, site: previous.site } : initial,
        signal,
        onReady,
      )
      if (!sealed || signal?.aborted) return undefined
      const name = sealed.name.trim()
      if (
        !validName(name) ||
        sealed.site.length > 512 ||
        sealed.backend !== "windows-dpapi-user-v1" ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(sealed.blob)
      )
        throw new Error("Vault secure input is invalid.")
      return lock(async () => {
        if (signal?.aborted) return undefined
        const entries = await load()
        const current = id ? entries.find((entry) => entry.id === id) : undefined
        if (id && !current) throw new Error("Vault entry no longer exists.")
        if (
          entries.some(
            (entry) =>
              entry.id !== id &&
              sameScope(entry, requestedScope, requestedScope === "global" ? undefined : options.projectID) &&
              entry.name.toLowerCase() === name.toLowerCase(),
          )
        )
          throw new Error("Vault name already exists.")
        // ASCII safe prefix plus stable random suffix avoids Unicode/case collisions.
        const entryID = current?.id ?? randomUUID()
        const prefix = `ORCH_SECRET_${
          name
            .toUpperCase()
            .replace(/[^A-Z0-9]+/g, "_")
            .slice(0, 24) || "ENTRY"
        }_${entryID.replace(/-/g, "").slice(0, 12).toUpperCase()}`
        const entry: Stored = {
          ...(current ?? {}),
          ...(requestedScope ? { scope: requestedScope, allowedSessionIDs: current?.allowedSessionIDs ?? [] } : {}),
          ...(current || requestedScope === "global" ? {} : options.projectID ? { projectID: options.projectID } : {}),
          empty: false,
          version: 1,
          id: entryID,
          name,
          site: sealed.site,
          variables: current?.variables ?? { login: `${prefix}_LOGIN`, password: `${prefix}_PASSWORD` },
          backend: sealed.backend,
          blob: sealed.blob,
        }
        if (signal?.aborted) return undefined
        await save([...entries.filter((row) => row.id !== entryID), entry])
        return publicName(entry)
      })
    },
    bindFromOperator: async (id: string, projectID: string) => {
      if (!projectID || projectID.length > 200) throw Error("Verified project required")
      await lock(async () => {
        const entries = await load(),
          entry = entries.find((item) => item.id === id)
        if (!entry) throw Error("Vault entry no longer exists")
        if (entry.scope === "global") return
        if (entry.scope === "project" && entry.projectID !== projectID)
          throw Error("Local Vault slots cannot be shared with another project.")
        if (
          entries.some(
            (item) =>
              item.id !== id &&
              (item.projectID === projectID || item.projectIDs?.includes(projectID)) &&
              item.name === entry.name,
          )
        )
          throw Error("Project already has that Vault name")
        entry.projectIDs = [...new Set([...(entry.projectIDs ?? []), projectID])]
        await save(entries)
      })
    },
    checkHttp: async (name: string, url: string, scope: VaultAccess.Scope) => {
      if (!options.projectID || scope.projectID !== options.projectID) throw Error("Vault project mismatch")
      VaultAccess.requireAccess(scope)
      const matches = (await load()).filter((item) => visible(item) && item.name === name)
      if (matches.length !== 1)
        throw Error("Vault name is missing or ambiguous in this project. Select a unique slot name.")
      const entry = matches[0]
      if (
        entry.empty ||
        (entry.allowedSessionIDs !== undefined && !entry.allowedSessionIDs.includes(scope.sessionID))
      ) {
        await audit(entry, scope, "denied")
        throw Error(
          entry.empty
            ? "Vault slot is empty; use masked operator input first."
            : "This session is not allowed to use the Vault slot.",
        )
      }
      const target = allowedUrl(entry.site, url)
      await (options.checkUrl ?? Ssrf.assertPublicUrlPromise)(target.href)
      VaultAccess.requireAccess(scope)
      await audit(entry, scope, "attempt")
      VaultAccess.requireAccess(scope)
      const latest = (await load()).find((item) => item.id === entry.id && visible(item))
      if (
        !latest ||
        latest.empty ||
        latest.blob !== entry.blob ||
        (latest.allowedSessionIDs !== undefined && !latest.allowedSessionIDs.includes(scope.sessionID))
      )
        throw Error("Vault slot changed or access was revoked before use.")
      try {
        const result = httpSummary(await (options.request ?? nativeHttp())(entry.blob, target.href))
        await audit(entry, scope, "success")
        return result
      } catch {
        await audit(entry, scope, "failed")
        throw Error("Vault HTTP failed; output withheld.")
      }
    },
    deleteFromOperator: async (id: string, confirmed: boolean) => {
      if (!confirmed) throw new Error("Vault deletion requires operator confirmation.")
      await lock(async () => {
        const entries = await load()
        const entry = entries.find((row) => row.id === id && visible(row))
        if (!entry) throw Error("Vault slot is unavailable.")
        await save(entries.filter((row) => row.id !== id))
      })
    },
  }
}
export const local = (projectID?: string, dataDirectory = Global.Path.data) =>
  make({ directory: path.join(dataDirectory, "credential-vault"), collector: collector(), projectID })
