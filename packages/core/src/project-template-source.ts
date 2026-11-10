export * as ProjectTemplateSource from "./project-template-source.js"

import { ProjectTemplate } from "./project-template.js"
import type { CredentialVault } from "./credential-vault/index.js"
import type { Trigger } from "./trigger.js"

/** Explicit metadata readers only. Do not pass a project directory to a recursive copier.
 * The live adapter must read persisted saved URL lists, never connect to a browser or read DOM.
 * Global requirements and integration definitions are operator-selected, not all account settings. */
export interface Source {
  project: { id: string; name: string }
  sessions: readonly { id: string; title?: string; agent?: string; model?: { providerID: string; modelID: string; variant?: string } }[]
  /** Already verified project ownership by the caller, including its main session. */
  ownedSessionIDs: ReadonlySet<string>
  browsers: readonly { id: string; name: string; projectID: string; mode: "headless" | "window" | "capture"; savedLinks: readonly string[] }[]
  rules: readonly { scope: "project" | "session"; sessionID?: string; text: string }[]
  schedules: readonly Trigger.Info[]
  vault: readonly CredentialVault.SlotInfo[]
  selectedGlobalSlotIDs: ReadonlySet<string>
  providers: ProjectTemplate.Bundle["providers"]
  mcp: ProjectTemplate.Bundle["mcp"]
}

/** Allowlist projection, then closed-schema validation. No source runtime IDs survive output.
 * Unsupported conditions/actions fail the whole capture, so a partial export cannot look complete.
 * This only prepares a preview; its digest grants no import, start or external disclosure authority. */
export function capture(source: Source, metadata: { name: string; description: string; minOrchestraVersion: string }) {
  try {
    if (!source.project.id || !source.project.name) throw Error()
    const sessions = new Map<string, string>(), browsers = new Map<string, string>()
    const sessionRows = source.sessions.map((row, index) => {
      if (!source.ownedSessionIDs.has(row.id) || sessions.has(row.id) || !row.agent || !row.title) throw Error()
      const slot = `session_${index + 1}`; sessions.set(row.id, slot)
      return { slot, title: row.title, role: row.agent, model: row.model ? { provider: row.model.providerID, id: row.model.modelID, variant: row.model.variant ?? null } : null }
    })
    // An absent session is not silently hidden. Ownership and reader output must match exactly.
    if (sessions.size !== source.ownedSessionIDs.size) throw Error()
    const browserRows = source.browsers.map((row, index) => {
      if (row.projectID !== source.project.id || browsers.has(row.id)) throw Error()
      const slot = `browser_${index + 1}`; browsers.set(row.id, slot)
      return { slot, name: row.name, mode: row.mode, links: [...row.savedLinks] }
    })
    const rules = source.rules.map((row) => {
      if (row.scope === "project") { if (row.sessionID !== undefined) throw Error(); return { session: null, text: row.text } }
      if (row.scope !== "session" || !row.sessionID || !sessions.has(row.sessionID)) throw Error()
      return { session: sessions.get(row.sessionID)!, text: row.text }
    })
    if (new Set(source.schedules.map((row) => row.id)).size !== source.schedules.length) throw Error()
    const schedules: ProjectTemplate.Bundle["schedules"] = source.schedules.map((row, index) => {
      if (row.projectID !== source.project.id || row.localTest || row.browserSessionID || row.actions?.length || row.errors || row.maxPerHour === null) throw Error()
      let def: ProjectTemplate.Bundle["schedules"][number]["source"]
      if (row.kind === "browser") {
        if ((row.condition && (row.condition.type !== "browser" || row.condition.sessionID !== row.spec || row.condition.match !== row.match)) || !browsers.has(row.spec)) throw Error()
        def = { kind: "browser", browser: browsers.get(row.spec)!, match: row.match ?? null }
      } else if (row.kind === "internal") {
        if (!row.condition || row.condition.type !== "orchestra" || !sessions.has(row.condition.sessionID) || row.match) throw Error()
        def = { kind: row.condition.event, session: sessions.get(row.condition.sessionID)! }
      } else {
        if ((row.condition && (row.condition.type !== "time" || row.condition.kind !== row.kind || row.condition.spec !== row.spec)) || row.match) throw Error()
        def = { kind: row.kind, spec: row.spec }
      }
      return { slot: `schedule_${index + 1}`, source: def, instruction: row.prompt, maxPerHour: row.maxPerHour, maxPerDay: row.maxPerDay, missedPolicy: row.missedPolicy ?? "skip" }
    })
    const local: ProjectTemplate.Bundle["vault"]["local"] = [], globalRequirements: string[] = []
    const selected = new Set(source.selectedGlobalSlotIDs)
    for (const row of source.vault) {
      if (row.scope === "legacy") throw Error()
      if (row.scope === "project") {
        if (row.projectID !== source.project.id) throw Error()
        local.push({ name: row.name, type: row.type, label: row.label })
      } else if (selected.has(row.id)) {
        if (row.scope !== "global") throw Error()
        globalRequirements.push(row.name); selected.delete(row.id)
      }
    }
    if (selected.size) throw Error()
    return ProjectTemplate.preview(JSON.stringify({
      format: "orchestra.project-template", version: 1, ...metadata,
      variables: { projectName: source.project.name, folder: "${projectFolder}" },
      sessions: sessionRows, browsers: browserRows, rules, schedules,
      vault: { local, globalRequirements },
      providers: source.providers.map((p) => ({ id: p.id, endpoint: p.endpoint, credentialSlots: [...p.credentialSlots] })),
      mcp: source.mcp.map((p) => ({ name: p.name, catalog: p.catalog, credentialSlots: [...p.credentialSlots] })),
    }))
  } catch { return { ok: false as const, error: "Project configuration cannot be transferred completely. Check ownership, role/model bindings and unsupported schedule settings. No template was prepared." } }
}
