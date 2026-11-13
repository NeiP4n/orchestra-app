export * as ProjectTemplateLiveStores from "./project-template-live-stores.js"

import { destinationRoot } from "./project-template-destination-root.js"
import { unlinkedPath } from "./project-template-path.js"

import { isDeepStrictEqual } from "node:util"
import { constants } from "node:fs"
import { lstat, mkdir, open, readdir } from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { Effect, Schema } from "effect"
import { Flock } from "@orchestra/util/flock"
import { SessionID } from "@orchestra/schema/session-id"
import { Agent } from "@orchestra/schema/agent"
import { Model } from "@orchestra/schema/model"
import type { KV } from "./kv.js"
import type { Session } from "@orchestra/schema/session"
import type { Permission } from "@orchestra/schema/permission"
import type { SessionStore } from "./session/store.js"
import { AbsolutePath } from "./schema.js"
import { Orchestra } from "@orchestra/schema/orchestra"
import { CredentialVault } from "./credential-vault/index.js"
import { ProjectTemplate } from "./project-template.js"
import { ProjectTemplateImport } from "./project-template-import.js"
import { ProjectTemplateMaterialize as Materialize } from "./project-template-materialize.js"
import { Dod } from "./dod.js"
import { Trigger } from "./trigger.js"

export const RECEIPT = "orchestra/template-import/"
export const PROJECT_IMPORT = "orchestra/project-import/"
export const SESSION_IMPORT = "orchestra:template-import"
const record = (value: unknown): value is Record<string, KV.Value> =>
  !!value && typeof value === "object" && !Array.isArray(value)
const serial = (value: unknown): KV.Value => JSON.parse(JSON.stringify(value))
const exact = isDeepStrictEqual
export type ProcessAdapter = Materialize.ProcessAdapter
export interface Dependencies {
  kv: KV.Interface
  process?: ProcessAdapter
  sessions: {
    create: (input: {
      id: Session.ID
      title?: string
      agent?: Agent.ID
      location: { directory: AbsolutePath }
      permissions: Permission.Ruleset
      metadata: Session.Metadata
      model?: Model.Ref
    }) => Effect.Effect<Session.Info, unknown>
  }
  store: SessionStore.Interface
  /** Validated parent root. Only a server-owned fresh child may be used as project directory. */
  root: string
  installedVersion: string
  timezone: string
  /** These bootstrap the same fresh local DoD/files as regular project creation, without swallowing errors. */
  bootstrap: (directory: string, name: string) => Promise<void>
  browsers: {
    ensure: (receipt: Materialize.Receipt, rows: Materialize.Plan["browsers"]) => Promise<void>
    verify: (receipt: Materialize.Receipt, rows: Materialize.Plan["browsers"]) => Promise<void>
  }
  availableRoles: () => Promise<ReadonlySet<string>>
  availableModels: () => Promise<ReadonlySet<string>>
  vault?: (projectID: string) => ReturnType<typeof CredentialVault.local>
}
async function realDirectory(directory: string) {
  const stat = await lstat(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink() || !(await unlinkedPath(directory)))
    throw Error("Import directory cannot use links.")
}
async function ownedDirectory(receipt: Materialize.Receipt, root: string) {
  if (receipt.directory !== path.join(root, receipt.id))
    throw Error("Import directory is not the reserved fresh destination.")
  await destinationRoot(root)
  await mkdir(root, { recursive: true, mode: 0o700 })
  await realDirectory(root)
  let created = false
  try {
    await mkdir(receipt.directory, { mode: 0o700 })
    created = true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
  }
  await realDirectory(receipt.directory)
  const marker = path.join(receipt.directory, ".orchestra-template-import.json"),
    expected = JSON.stringify({ version: 1, id: receipt.id, projectID: receipt.projectID }) + "\n"
  const entries = await readdir(receipt.directory)
  if (!created && !entries.includes(path.basename(marker)) && entries.length)
    throw Error("Import directory contains foreign files.")
  try {
    const file = await open(marker, "wx", 0o600)
    try {
      await file.writeFile(expected)
      await file.sync()
    } finally {
      await file.close()
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
  }
  const info = await lstat(marker)
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 512)
    throw Error("Import directory owner marker is invalid.")
  const file = await open(marker, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const stat = await file.stat()
    if (stat.ino !== info.ino || stat.dev !== info.dev || (await file.readFile("utf8")) !== expected)
      throw Error("Import directory belongs to another operation.")
  } finally {
    await file.close()
  }
}
export function make(deps: Dependencies) {
  const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)
  const vault = deps.vault ?? CredentialVault.local
  const readReceipt = async (id: string) => {
    const value = await run(deps.kv.get(RECEIPT + id))
    if (value === undefined) return undefined
    if (!record(value) || value.version !== 1 || value.id !== id || !Materialize.PHASES.includes(value.phase as never))
      throw Error("Import receipt is damaged.")
    return value as unknown as Materialize.Receipt
  }
  const putExact = async (key: string, value: KV.Value) => {
    await run(
      deps.kv.atomicUpdate(key, (current) => {
        if (current !== undefined && !exact(current, value))
          throw Error("Import refuses to replace changed or foreign configuration.")
        return value
      }),
    )
  }
  const slots = (r: Materialize.Receipt) =>
    r.plan.localVaultSlots.map((slot, index) => ({
      id: `slot_${r.id}_${index + 1}`,
      name: slot.name,
      label: slot.label,
      type: slot.type,
    }))
  const ruleScopes = (r: Materialize.Receipt) => {
    const result = new Map<string, KV.Value[]>([[`project-defaults:${r.projectID}`, []]])
    r.plan.rules.forEach((row, index) => {
      const rows = result.get(row.scope) ?? []
      rows.push({ id: `${r.id}_${index + 1}`, text: row.text, by: "operator", at: 0 })
      result.set(row.scope, rows)
    })
    return result
  }
  const sessionExpected = (r: Materialize.Receipt, s: Materialize.Plan["sessions"][number]) => ({
    title: s.title,
    agent: s.role ?? undefined,
    location: { directory: r.directory },
    permissions: [],
    model: ProjectTemplateImport.sessionModelRef(s.model),
  })
  const verifySession = async (r: Materialize.Receipt, s: Materialize.Plan["sessions"][number]) => {
    const info = await run(deps.store.get(SessionID.make(s.id))),
      expected = sessionExpected(r, s)
    const differences = {
      missing: !info,
      parent: !!info?.parentID,
      receipt: info?.metadata?.[SESSION_IMPORT] !== r.id,
      owner: info?.metadata?.[Orchestra.SessionOwnerMetadataKey] !== r.projectID,
      title: info?.title !== expected.title,
      agent: info?.agent !== expected.agent,
      directory: info?.location.directory !== r.directory,
      permissions: !exact(info?.permissions, []),
      model: !exact(await run(deps.store.getStoredModel(SessionID.make(s.id))), expected.model),
      fallbacks:
        r.process !== undefined &&
        !Object.entries(deps.process!.metadata(r, s)).every(([key, value]) => exact(info?.metadata?.[key], value)),
      tokens: !!info?.tokens.input || !!info?.tokens.output,
      messages: info ? (await run(deps.store.messages({ sessionID: info.id, limit: 1 }))).length > 0 : false,
    }
    const failed = Object.entries(differences)
      .filter(([, failed]) => failed)
      .map(([key]) => key)
    if (failed.length) throw Error("Imported session verification failed: " + failed.join(", "))
    if ((await run(deps.kv.get("orchestra/owner/" + s.id))) !== r.projectID)
      throw Error("Imported session owner differs.")
  }
  const project = (r: Materialize.Receipt) => ({
    id: r.projectID,
    name: r.name,
    directory: r.directory,
    created: r.createdAt,
    main: r.plan.mainSessionID!,
    // Match normal project creation. Otherwise a live project listing migrates
    // this field between publish and verifyPublished and breaks exact replay.
    workEnabled: true,
  })
  const service = Materialize.make({
    lock: (id, action) => Flock.withLock(path.join(deps.root, id + ".import-lock"), action),
    readReceipt,
    createReceipt: async (r) => {
      await run(
        deps.kv.atomicUpdate(RECEIPT + r.id, (current) => {
          if (current !== undefined) throw Error("Import receipt already exists.")
          return serial(r)
        }),
      )
    },
    updateReceipt: async (r) => {
      await run(
        deps.kv.atomicUpdate(RECEIPT + r.id, (current) => {
          if (!record(current)) throw Error("Missing receipt.")
          const { phase: _a, ...a } = current,
            { phase: _b, ...b } = serial(r) as { [key: string]: KV.Value }
          if (!exact(a, b)) throw Error("Import reservation changed.")
          return serial(r)
        }),
      )
    },
    ensureProcess: async (r) => {
      if (!deps.process || !r.process) throw Error("Reviewed process adapter required")
      await deps.process.validate(r)
      await putExact(PROJECT_IMPORT + r.projectID, r.id)
      await putExact("orchestra/project/" + r.projectID, serial(project(r)))
      await deps.process.ensure(r)
    },
    verifyProcess: async (r) => {
      if (!deps.process || !r.process) throw Error("Reviewed process adapter required")
      await deps.process.validate(r)
      await deps.process.verify(r)
    },
    ensureDirectory: async (r) => {
      await ownedDirectory(r, deps.root)
      await run(Dod.initialize(r.directory))
    },
    ensureSession: async (r, s) => {
      const id = SessionID.make(s.id),
        existing = await run(deps.store.get(id))
      if (existing) {
        await verifySession(r, s)
        return
      }
      await putExact("orchestra/owner/" + s.id, r.projectID)
      const expected = sessionExpected(r, s)
      await run(
        deps.sessions.create({
          id,
          title: s.title,
          agent: s.role === null ? undefined : Agent.ID.make(s.role),
          location: { directory: AbsolutePath.make(r.directory) },
          permissions: [],
          metadata: {
            [SESSION_IMPORT]: r.id,
            [Orchestra.SessionOwnerMetadataKey]: r.projectID,
            ...(r.process ? deps.process!.metadata(r, s) : {}),
          },
          ...(expected.model ? { model: Schema.decodeUnknownSync(Model.Ref)(expected.model) } : {}),
        }),
      )
      await verifySession(r, s)
    },
    ensureRules: async (r) => {
      for (const [scope, rows] of ruleScopes(r)) await putExact("rules/" + scope, rows)
    },
    ensureVault: async (r) => {
      await vault(r.projectID).ensureImportedEmptySlotsFromOperator(r.id, slots(r))
    },
    ensureBrowsers: (r, rows) => deps.browsers.ensure(r, rows),
    ensureSchedules: async (r, rows) => {
      for (const row of rows) await putExact(Trigger.key(r.projectID, row.id), serial(row))
    },
    verify: async (r) => {
      await ownedDirectory(r, deps.root)
      for (const s of r.plan.sessions) await verifySession(r, s)
      for (const [scope, rows] of ruleScopes(r))
        if (!exact(await run(deps.kv.get("rules/" + scope)), rows)) throw Error("Imported rules changed.")
      const current = (await vault(r.projectID).slots()).filter(
          (row) => row.scope === "project" && row.projectID === r.projectID,
        ),
        reserved = slots(r)
      if (
        current.length !== reserved.length ||
        reserved.some(
          (slot) =>
            !current.some(
              (row) =>
                row.id === slot.id &&
                row.name === slot.name &&
                row.label === slot.label &&
                row.type === slot.type &&
                row.scope === "project" &&
                row.projectID === r.projectID &&
                row.state === "empty" &&
                row.allowedSessionIDs.length === 0,
            ),
        )
      )
        throw Error("Imported Vault changed.")
      for (const row of r.plan.schedules)
        if (!exact(await run(deps.kv.get(Trigger.key(r.projectID, row.id))), serial(row)))
          throw Error("Imported schedule changed.")
      await deps.browsers.verify(r, r.plan.browsers)
      await putExact(
        "orchestra/template-requirements/" + r.projectID,
        serial({ globals: r.plan.globalRequirements, integrations: r.plan.integrationRequirements }),
      )
    },
    publish: async (r) => {
      // The raw owner record is required by the regular rule/file bootstrap. Read APIs
      // hide it and admission holds its sessions until the receipt checkpoint commits.
      await putExact(PROJECT_IMPORT + r.projectID, r.id)
      await putExact("orchestra/project/" + r.projectID, serial(project(r)))
      await deps.bootstrap(r.directory, r.name)
    },
    verifyPublished: async (r) => {
      if (!exact(await run(deps.kv.get("orchestra/project/" + r.projectID)), serial(project(r))))
        throw Error("Imported project publication differs.")
    },
  })
  return {
    reserve: async (serialized: string, digest: string) => {
      const id = "pti_" + randomUUID().replaceAll("-", ""),
        projectID = Orchestra.ProjectID.create()
      const original = ProjectTemplate.preview(serialized)
      const process =
        !original.ok && deps.process ? await deps.process.prepare(serialized, digest, projectID) : undefined
      const preview = process ? ProjectTemplate.preview(process.template) : original
      if (!preview.ok || (!process && preview.value.digest !== digest)) throw Error("Template changed after review.")
      const bundle = preview.value.bundle
      const createdAt = Date.now()
      const plan = ProjectTemplateImport.prepare(preview.value.text, {
        projectID,
        installedVersion: deps.installedVersion,
        reviewedDigest: preview.value.digest,
        now: createdAt,
        timezone: deps.timezone,
        sessions: Object.fromEntries(bundle.sessions.map((s) => [s.slot, SessionID.create()])),
        browsers: Object.fromEntries(bundle.browsers.map((s) => [s.slot, "brw_" + randomUUID().replaceAll("-", "")])),
        schedules: Object.fromEntries(bundle.schedules.map((s) => [s.slot, "trg_" + randomUUID().replaceAll("-", "")])),
        availableRoles: process?.roles ?? (await deps.availableRoles()),
        availableModels: await deps.availableModels(),
      })
      if (!plan.mainSessionID) throw Error("Template requires one explicit main Orchestrator.")
      const r: Materialize.Receipt = {
        version: 1,
        createdAt,
        template: preview.value.text,
        timezone: deps.timezone,
        id,
        projectID,
        name: bundle.variables.projectName,
        directory: path.join(deps.root, id),
        digest: preview.value.digest,
        ...(process ? { process: process.process } : {}),
        phase: "reserved",
        plan,
      }
      await run(
        deps.kv.atomicUpdate(RECEIPT + id, (current) => {
          if (current !== undefined) throw Error("Reservation collision.")
          return serial(r)
        }),
      )
      return r
    },
    resume: async (id: string) => {
      if (!/^pti_[A-Za-z0-9_-]{1,100}$/.test(id)) throw Error("Invalid import ID.")
      const receipt = await readReceipt(id)
      if (!receipt) throw Error("Unknown import reservation.")
      // Re-derive every writable definition from the closed portable source. A damaged
      // receipt can never invent a global rule key, a role, a permission, or a new identity.
      if (receipt.process && !deps.process) throw Error("This process import requires the reviewed v2 adapter")
      const processRoles = receipt.process ? await deps.process!.validate(receipt) : undefined
      const expected = ProjectTemplateImport.prepare(receipt.template, {
        projectID: receipt.projectID,
        installedVersion: deps.installedVersion,
        reviewedDigest: receipt.digest,
        now: receipt.createdAt,
        timezone: receipt.timezone,
        sessions: Object.fromEntries(receipt.plan.sessions.map((row) => [row.slot, row.id])),
        browsers: Object.fromEntries(receipt.plan.browsers.map((row) => [row.slot, row.id])),
        schedules: Object.fromEntries(
          receipt.plan.schedules.map((row, index) => {
            const preview = ProjectTemplate.preview(receipt.template)
            if (!preview.ok) throw Error("Damaged import source.")
            return [preview.value.bundle.schedules[index]?.slot, row.id]
          }),
        ),
        availableRoles: processRoles ?? (await deps.availableRoles()),
        availableModels: await deps.availableModels(),
      })
      if (!exact(serial(expected), serial(receipt.plan)) || receipt.directory !== path.join(deps.root, receipt.id))
        throw Error("Import reservation no longer matches its source.")
      const result = await service.apply(receipt)
      if (receipt.process) {
        try {
          await deps.process!.changed()
        } catch {
          // The durable checkpoint is already published. A best-effort UI
          // invalidation cannot turn this committed create into a failed create.
          // Repeated confirms still revalidate the stores and retry notification.
          await run(Effect.logWarning("project template notification deferred", {
            operation: "confirmCreate", stage: "process-bindings", reasonCode: "read-failed",
          }))
        }
      }
      return result
    },
    readReceipt,
    held: (sessionID: string) =>
      Effect.gen(function* () {
        const session = yield* deps.store.get(SessionID.make(sessionID)),
          id = session?.metadata?.[SESSION_IMPORT]
        if (id === undefined) return false
        if (typeof id !== "string") return true
        const receipt = yield* deps.kv.get(RECEIPT + id)
        return (
          !record(receipt) ||
          receipt.phase !== "published" ||
          receipt.projectID !== session?.metadata?.[Orchestra.SessionOwnerMetadataKey]
        )
      }),
  }
}
