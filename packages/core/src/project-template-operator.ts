export * as ProjectTemplateOperator from "./project-template-operator.js"

import path from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { Effect, Schema } from "effect"
import { Flock } from "@orchestra/util/flock"
import { Orchestra } from "@orchestra/schema/orchestra"
import { SessionID } from "@orchestra/schema/session-id"
import { ProjectTemplateV2Reader } from "./project-template-v2-reader.js"
import { ProjectTemplateV2Library } from "./project-template-v2-library.js"
import { ProjectTemplateReader } from "./project-template-reader.js"
import { ProjectTemplateBrowser } from "./project-template-browser.js"
import { ProjectTemplateLibrary } from "./project-template-library.js"
import { ProjectTemplateLiveStores as Live } from "./project-template-live-stores.js"
import { ProjectTemplateBrowserStore as Browsers } from "./project-template-browser-store.js"
import { CredentialVault } from "./credential-vault/index.js"
import { ProjectTemplateTriggerReview } from "./project-template-trigger-review.js"
import { AbsolutePath } from "./schema.js"
import type { KV } from "./kv.js"
import type { SessionStore } from "./session/store.js"

export const PREPARED = "orchestra/template-prepared/"
export type BrowserInput = Omit<ProjectTemplateBrowser.Definition, "projectID">
interface Save {
  kind: "save"
  phase: "prepared" | "saved"
  projectID: string
  libraryID: string
  digest: string
  text: string
  name: string
  linkReview?: ProjectTemplateBrowser.Review
  previousDigest?: string
}
interface Create {
  kind: "create"
  settingsDirectory: string
  libraryID: string
  digest: string
  done?: boolean
}
interface Deps {
  kv: KV.Interface
  store: SessionStore.Interface
  dataDirectory: string
  installedVersion: string
  processStores?: (projectID: string) => ProjectTemplateV2Reader.Stores
  live: (settingsDirectory: string) => ReturnType<typeof Live.make>
}
const json = (v: unknown): KV.Value => JSON.parse(JSON.stringify(v))
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v)
export function make(deps: Deps) {
  const legacy = ProjectTemplateLibrary.local(deps.dataDirectory)
  const processes = ProjectTemplateV2Library.local(deps.dataDirectory)
  const processID = (id: string) => (id.startsWith("process:") ? id.slice(8) : undefined)
  const library = {
    list: async () => [
      ...(await legacy.list()),
      ...(deps.processStores
        ? (await processes.list()).map((row) => ({
            name: "process:" + row.id,
            title: row.name,
            state: row.state,
            digest: row.digest,
          }))
        : []),
    ],
    preview: (id: string) => (processID(id) !== undefined ? processes.preview(processID(id)!) : legacy.preview(id)),
    replaceSerialized: (text: string, id: string, previous: string, digest: string) =>
      processID(id) !== undefined
        ? processes.replaceSerialized(text, processID(id)!, previous, digest)
        : legacy.replaceSerialized(text, id, previous, digest),
    saveSerialized: (text: string, id: string, digest: string) =>
      processID(id) !== undefined
        ? processes.saveSerialized(text, processID(id)!, digest)
        : legacy.saveSerialized(text, id, digest),
  }
  const run = <A, E>(e: Effect.Effect<A, E>) => Effect.runPromise(e)
  const ready = async (projectID: string) => {
    const project = Schema.decodeUnknownSync(Orchestra.Project)(
      await run(deps.kv.get("orchestra/project/" + projectID)),
    )
    if (project.id !== projectID) throw Error("Project owner differs.")
    const marker = await run(deps.kv.get(Live.PROJECT_IMPORT + projectID))
    if (marker === undefined) return
    if (typeof marker !== "string") throw Error("Invalid project import marker.")
    const receipt = await run(deps.kv.get(Live.RECEIPT + marker))
    if (!record(receipt) || receipt.phase !== "published" || receipt.projectID !== projectID || receipt.id !== marker)
      throw Error("Project import is not complete.")
  }
  const capture = async (projectID: string, browsers: readonly BrowserInput[], process = !!deps.processStores) => {
    const linkReview: ProjectTemplateBrowser.Review = { issues: [], fingerprint: "" }
    await ready(projectID)
    const project = Schema.decodeUnknownSync(Orchestra.Project)(
      await run(deps.kv.get("orchestra/project/" + projectID)),
    )
    const vault = await CredentialVault.local(projectID, deps.dataDirectory).slots()
    // Only explicit per-project integration requirements travel. Global account configuration
    // is not project configuration and is never swept into the template.
    const raw = await run(deps.kv.get("orchestra/template-requirements/" + projectID))
    let providers: Parameters<typeof ProjectTemplateReader.capture>[3]["providers"] = [],
      mcp: Parameters<typeof ProjectTemplateReader.capture>[3]["mcp"] = [],
      globalNames: string[] = []
    if (raw !== undefined) {
      if (
        !record(raw) ||
        !record(raw.integrations) ||
        !Array.isArray(raw.globals) ||
        !Array.isArray(raw.integrations.providers) ||
        !Array.isArray(raw.integrations.mcp)
      )
        throw Error("Project integration requirements cannot be read completely.")
      providers = raw.integrations.providers as typeof providers
      mcp = raw.integrations.mcp as typeof mcp
      globalNames = raw.globals.map((row) => {
        if (!record(row) || typeof row.name !== "string") throw Error("Invalid global requirement.")
        return row.name
      })
    }
    const selected = new Set<string>()
    for (const name of globalNames) {
      const matches = vault.filter((row) => row.scope === "global" && row.name === name)
      if (matches.length > 1) throw Error("A project global Vault requirement is ambiguous.")
      if (matches.length === 0) {
        const id = "requirement_" + selected.size
        vault.push({ id, name, type: "login", label: name, scope: "global", state: "empty", allowedSessionIDs: [] })
        selected.add(id)
      } else selected.add(matches[0].id)
    }
    const linked = {
      browsers: await ProjectTemplateBrowser.capture(
        deps.dataDirectory,
        projectID,
        browsers.map((row) => ({ ...row, projectID })),
        linkReview,
      ),
      vault,
      selectedGlobalSlotIDs: selected,
      providers,
      mcp,
    }
    const metadata = {
      name: project.name,
      description: "Настройки проекта без чатов, данных и секретов.",
      minOrchestraVersion: deps.installedVersion,
    }
    if (process && !deps.processStores) throw Error("Process template export is unavailable in this build.")
    const preview = process
      ? await ProjectTemplateV2Reader.capture(deps.processStores!(projectID), projectID, metadata, linked)
      : await run(
          ProjectTemplateReader.capture(
            {
              kv: deps.kv,
              getSession: (id) => deps.store.get(SessionID.make(id)),
              listSessionsInTree: (directory) =>
                deps.store.list({ directoryPrefix: AbsolutePath.make(directory), parentID: null }),
            },
            projectID,
            metadata,
            linked,
          ),
        )
    return { ...preview, linkReview }
  }
  const prepared = async (token: string) => {
    if (!/^(?:pts_|pti_)[A-Za-z0-9_-]{1,100}$/.test(token)) throw Error("Invalid prepared operation.")
    const value = await run(deps.kv.get(PREPARED + token))
    if (!record(value) || !["save", "create"].includes(String(value.kind))) throw Error("Unknown prepared operation.")
    return value as unknown as Save | Create
  }
  return {
    list: async () =>
      (await library.list())
        .filter((row) => row.state === "ready")
        .map((row) => ({ id: row.name, name: row.title ?? row.name })),
    prepareSave: async (projectID: string, browsers: readonly BrowserInput[], templateID?: string) => {
      const prior = templateID === undefined ? undefined : await library.preview(templateID)
      // Updating an existing v1 entry stays v1. Format upgrades are a separate explicit choice.
      const preview = await capture(projectID, browsers, prior ? prior.bundle.version === 2 : !!deps.processStores),
        suffix = randomUUID().replaceAll("-", ""),
        token = "pts_" + suffix
      const value: Save = {
        kind: "save",
        phase: "prepared",
        projectID,
        libraryID: templateID ?? (deps.processStores ? "process:" : "") + "template_" + suffix,
        ...(prior ? { previousDigest: prior.digest } : {}),
        digest: preview.digest,
        text: preview.text,
        name: preview.bundle.name,
        linkReview: preview.linkReview,
      }
      await run(
        deps.kv.atomicUpdate(PREPARED + token, (current) => {
          if (current !== undefined) throw Error("Save reservation collision.")
          return json(value)
        }),
      )
      return {
        token,
        name: prior?.bundle.name ?? value.name,
        details: preview.text,
        omittedLinks: preview.linkReview.issues,
        triggerReview: ProjectTemplateTriggerReview.review(
          { ...preview.bundle, version: 1 },
          preview.linkReview.issues,
        ),
      }
    },
    confirmSave: async (token: string, browsers: readonly BrowserInput[], omitUnsafeLinks = false) =>
      Flock.withLock(token, async () => {
        const pending = await prepared(token)
        if (pending.kind !== "save") throw Error("Wrong operation kind.")
        if (pending.linkReview?.issues.length && !omitUnsafeLinks)
          throw Error("Saved links contain nonportable parameters. Review before saving.")
        if (pending.previousDigest !== undefined) {
          const existing = await library.preview(pending.libraryID)
          if (existing.digest === pending.digest) {
            await run(deps.kv.set(PREPARED + token, json({ ...pending, phase: "saved" })))
            return
          }
          if (pending.phase === "saved" || existing.digest !== pending.previousDigest)
            throw Error("Template changed after preview. Review it again.")
          const current = await capture(pending.projectID, browsers, processID(pending.libraryID) !== undefined)
          if (current.digest !== pending.digest || (pending.linkReview && JSON.stringify(current.linkReview) !== JSON.stringify(pending.linkReview)))
            throw Error("Project changed after confirmation preview. Review it again.")
          await library.replaceSerialized(pending.text, pending.libraryID, pending.previousDigest, pending.digest)
          await run(deps.kv.set(PREPARED + token, json({ ...pending, phase: "saved" })))
          return
        }
        let exists = false
        try {
          const existing = await library.preview(pending.libraryID)
          if (existing.digest !== pending.digest) throw Error("Existing template differs.")
          exists = true
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
        }
        if (!exists) {
          if (pending.phase === "saved") throw Error("Saved template is missing.")
          const current = await capture(pending.projectID, browsers)
          if (
            current.digest !== pending.digest ||
            (pending.linkReview && JSON.stringify(current.linkReview) !== JSON.stringify(pending.linkReview))
          )
            throw Error("Project changed after confirmation preview. Review it again.")
          await library.saveSerialized(pending.text, pending.libraryID, pending.digest)
        }
        await run(deps.kv.set(PREPARED + token, json({ ...pending, phase: "saved" })))
      }),
    prepareCreate: async (libraryID: string, settingsDirectory: string) => {
      if (!path.isAbsolute(settingsDirectory)) throw Error("A verified model settings directory is required.")
      const preview = await library.preview(libraryID)
      const key =
        "orchestra/template-create-reservation/" +
        createHash("sha256")
          .update(JSON.stringify([libraryID, settingsDirectory, preview.digest]))
          .digest("hex")
      return Flock.withLock(key, async () => {
        const previous = await run(deps.kv.get(key))
        if (typeof previous === "string") {
          const pending = await prepared(previous)
          if (
            pending.kind !== "create" ||
            pending.libraryID !== libraryID ||
            pending.settingsDirectory !== settingsDirectory ||
            pending.digest !== preview.digest
          )
            throw Error("Pending import index differs.")
          if (!pending.done) {
            const receipt = await deps.live(settingsDirectory).readReceipt(previous)
            if (!receipt) throw Error("Pending import receipt is missing.")
            return {
              token: receipt.id,
              name: receipt.name,
              details: receipt.process?.template ?? receipt.template,
              triggerReview: ProjectTemplateTriggerReview.fromText(receipt.template),
            }
          }
        } else if (previous !== undefined) throw Error("Pending import index is damaged.")
        const receipt = await deps.live(settingsDirectory).reserve(preview.text, preview.digest)
        await run(
          deps.kv.atomicUpdate(PREPARED + receipt.id, (current) => {
            if (current !== undefined) throw Error("Create reservation collision.")
            return json({ kind: "create", settingsDirectory, libraryID, digest: preview.digest } satisfies Create)
          }),
        )
        await run(deps.kv.set(key, receipt.id))
        return {
          token: receipt.id,
          name: receipt.name,
          details: preview.text,
          triggerReview: ProjectTemplateTriggerReview.review({ ...preview.bundle, version: 1 }),
        }
      })
    },
    finishCreate: async (token: string) => {
      const pending = await prepared(token)
      if (pending.kind !== "create") throw Error("Wrong operation kind.")
      const receipt = await deps.live(pending.settingsDirectory).readReceipt(token)
      if (!receipt || receipt.phase !== "published" || (receipt.process?.digest ?? receipt.digest) !== pending.digest)
        throw Error("Import has not finished.")
      await run(deps.kv.set(PREPARED + token, json({ ...pending, done: true })))
    },
    confirmCreate: async (token: string) => {
      const pending = await prepared(token)
      if (pending.kind !== "create") throw Error("Wrong operation kind.")
      const live = deps.live(pending.settingsDirectory),
        receipt = await live.readReceipt(token)
      if (!receipt || (receipt.process?.digest ?? receipt.digest) !== pending.digest)
        throw Error("Create reservation differs.")
      if (receipt.phase === "reserved") {
        const current = await library.preview(pending.libraryID)
        if (current.digest !== pending.digest) throw Error("Template changed after preview.")
      }
      const result = await live.resume(token)
      return {
        projectID: result.projectID,
        mainSessionID: result.plan.mainSessionID!,
        browsers: {
          importID: result.id,
          projectID: result.projectID,
          createdAt: result.createdAt,
          browsers: result.plan.browsers.map((row) => ({
            id: row.id,
            name: row.name,
            ...(row.chat ? { chat: row.chat } : {}),
            mode: row.mode,
          })),
        },
      }
    },
    browserDefinitions: async (projectID: string) => {
      await ready(projectID)
      const value = await Browsers.make(deps.kv, deps.dataDirectory).read(projectID)
      if (value === undefined) return null
      if (!record(value) || !Array.isArray(value.browsers)) throw Error("Imported browser definitions are damaged.")
      return {
        importID: String(value.importID),
        projectID,
        createdAt: Number(value.createdAt),
        browsers: value.browsers.map((row) => {
          if (
            !record(row) ||
            typeof row.id !== "string" ||
            typeof row.name !== "string" ||
            !["headless", "window", "capture"].includes(String(row.mode)) ||
            (row.chat !== undefined && typeof row.chat !== "string")
          )
            throw Error("Imported browser definition is invalid.")
          return {
            id: row.id,
            name: row.name,
            ...(row.chat ? { chat: row.chat as string } : {}),
            mode: row.mode as "headless" | "window" | "capture",
          }
        }),
      }
    },
  }
}
