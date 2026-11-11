export * as ProjectTemplateReader from "./project-template-reader.js"

import { Effect } from "effect"
import { Trigger } from "./trigger.js"
import { ProjectTemplateSource } from "./project-template-source.js"
import { Orchestra } from "@orchestra/schema/orchestra"
import { Schema } from "effect"
import { Federation } from "@orchestra/schema/federation"

/** Passive capture from live metadata stores, never the repairing Orchestra.sessions/main methods.
 * Browser/Vault/integration metadata must come from their owning live surface and be passed explicitly.
 * This function cannot read messages, memory, page data, plaintext, HTTP, shell or model execution. */
export interface SessionMetadata {
  id: string
  title?: string
  agent?: string
  parentID?: string
  location: { directory: string }
  metadata?: Record<string, Schema.Json>
  model?: { providerID: string; id: string; variant?: string }
}
export interface Stores {
  kv: {
    get: (key: string) => Effect.Effect<unknown>
    scan: (input: {
      prefix: string
      after?: string
      limit?: number
    }) => Effect.Effect<{ entries: readonly { key: string; value: unknown }[]; next?: string }>
  }
  getSession: (id: string) => Effect.Effect<SessionMetadata | undefined>
  listSessionsInTree: (directory: string) => Effect.Effect<readonly SessionMetadata[]>
}
export function readSource(
  stores: Stores,
  projectID: string,
  linked: Pick<ProjectTemplateSource.Source, "browsers" | "vault" | "selectedGlobalSlotIDs" | "providers" | "mcp">,
) {
  return Effect.gen(function* () {
    const raw = yield* stores.kv.get(`orchestra/project/${projectID}`)
    const project = Schema.decodeUnknownSync(Orchestra.Project)(raw)
    if (project.id !== projectID) throw Error("Project owner differs.")
    if (!project.main) throw Error("Project main session is not initialized.")
    const scan = (prefix: string) =>
      Effect.gen(function* () {
        const entries: { key: string; value: unknown }[] = []
        let after: string | undefined
        do {
          const page = yield* stores.kv.scan({ prefix, after, limit: 1000 })
          if (entries.length + page.entries.length > 10000 || (page.next === after && page.next !== undefined))
            throw Error("Configuration scan is incomplete.")
          entries.push(...page.entries)
          after = page.next
        } while (after)
        return entries
      })
    const owned = yield* scan("orchestra/owner/")
    const projects = (yield* scan("orchestra/project/")).map((row) =>
      Schema.decodeUnknownSync(Orchestra.Project)(row.value),
    )
    const claims = new Map(owned.map((row) => [row.key.slice("orchestra/owner/".length), row.value]))
    const ids = new Set<string>([project.main])
    // Match the owner's live roster semantics: child task sessions and stale ownership
    // markers are not top-level process definitions. Do not repair or delete them here.
    for (const row of owned.filter(row => row.value === projectID)) {
      const id = row.key.slice("orchestra/owner/".length)
      const info = yield* stores.getSession(id)
      if (id === project.main || (info && !info.parentID)) ids.add(id)
    }
    const tree = yield* stores.listSessionsInTree(project.directory)
    for (const info of tree) {
      if (info.parentID) continue
      const claimed = claims.get(info.id) ?? Orchestra.sessionOwner(info.metadata)
      if (typeof claimed !== "string" && claimed !== undefined) throw Error("Invalid session owner.")
      if (claimed === undefined && Federation.groupSupervisor(info.metadata) !== undefined) continue
      if (Orchestra.ownerOf(projects, info.location.directory, claimed)?.id === project.id) ids.add(info.id)
    }
    const sessions: ProjectTemplateSource.Source["sessions"][number][] = []
    for (const id of ids) {
      const info = yield* stores.getSession(id)
      if (!info) throw Error("Project main session is missing.")
      if (info.parentID) throw Error("Project main session points to a child task.")
      if (Orchestra.ownerOf(projects, info.location.directory, (claims.get(id) ?? Orchestra.sessionOwner(info.metadata)) as string | undefined)?.id !== project.id)
        throw Error(id === project.main ? "Project main session belongs to another project." : "A top-level session has conflicting project ownership.")
      sessions.push({
        id,
        title: info.title,
        agent: info.agent,
        model: info.model
          ? { providerID: info.model.providerID, modelID: info.model.id, variant: info.model.variant }
          : undefined,
      })
    }
    const roleRows = yield* scan(`rules/role:${projectID}:`)
    const scopes: {
      key: string
      scope: ProjectTemplateSource.Source["rules"][number]["scope"]
      sessionID?: string
      role?: string
    }[] = [
      { key: `project:${projectID}`, scope: "project" },
      { key: `project-defaults:${projectID}`, scope: "project-defaults" },
      { key: `orchestrator:${projectID}`, scope: "orchestrator" },
      ...[...ids].map((id) => ({ key: `session:${id}`, scope: "session" as const, sessionID: id })),
      ...roleRows.map((row) => ({
        key: row.key.slice("rules/".length),
        scope: "role" as const,
        role: row.key.slice(`rules/role:${projectID}:`.length),
      })),
    ]
    const rules: ProjectTemplateSource.Source["rules"][number][] = []
    for (const scope of scopes) {
      const value = yield* stores.kv.get("rules/" + scope.key)
      if (value === undefined) continue
      if (!Array.isArray(value)) throw Error("Rule metadata is damaged.")
      for (const row of value) {
        if (!row || typeof row !== "object" || Array.isArray(row) || typeof row.text !== "string")
          throw Error("Rule metadata is damaged.")
        rules.push({
          scope: scope.scope,
          ...(scope.sessionID ? { sessionID: scope.sessionID } : {}),
          ...(scope.role ? { role: scope.role } : {}),
          text: row.text,
        })
      }
    }
    const schedules: Trigger.Info[] = []
    for (const row of yield* scan(Trigger.PREFIX + projectID + "/")) {
      const trigger = Trigger.parse(row.value)
      if (!trigger || trigger.projectID !== projectID) throw Error("Schedule metadata is damaged.")
      schedules.push(trigger)
    }
    // Re-read the identity at closeout. Concurrent metadata edits still require the eventual
    // confirm adapter to recapture and compare the exact canonical digest before committing.
    const final = yield* stores.kv.get(`orchestra/project/${projectID}`)
    if (JSON.stringify(final) !== JSON.stringify(raw)) throw Error("Project changed during capture.")
    return { project, sessions, ownedSessionIDs: ids, rules, schedules, ...linked } satisfies ProjectTemplateSource.Source
  })
}

/** Existing v1 capture remains a strict projection of the same passive owned source. */
export function capture(
  stores: Stores,
  projectID: string,
  metadata: { name: string; description: string; minOrchestraVersion: string },
  linked: Pick<ProjectTemplateSource.Source, "browsers" | "vault" | "selectedGlobalSlotIDs" | "providers" | "mcp">,
) {
  return Effect.gen(function* () {
    const source = yield* readSource(stores, projectID, linked)
    const result = ProjectTemplateSource.capture(source, metadata)
    if (!result.ok) throw Error(result.error)
    return result.value
  })
}
