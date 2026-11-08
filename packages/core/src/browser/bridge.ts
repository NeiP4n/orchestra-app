export * as BrowserBridge from "./bridge.js"

import path from "node:path"

// Which browser session each project has selected. The Browser tab writes this file when the operator picks
// a session; the chat agent's browser tool reads it, so the agent acts in the same Chrome the operator sees.
// A plain JSON object: project directory -> browser session id.

export const file = (root: string) => path.join(root, "browser-profiles", "selected.json")

const norm = (value: string) => value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()

export function parse(text: string | undefined): Record<string, string> {
  if (!text) return {}
  try {
    const value = JSON.parse(text) as unknown
    if (!value || typeof value !== "object" || Array.isArray(value)) return {}
    return Object.fromEntries(
      Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    )
  } catch {
    return {}
  }
}

/** The selected session of the project that owns `directory`; the most specific project directory wins. */
export function selectedFor(map: Record<string, string>, directory: string): string | undefined {
  const target = norm(directory)
  let best: string | undefined
  for (const key of Object.keys(map)) {
    const base = norm(key)
    if (target !== base && !target.startsWith(base + "/")) continue
    if (best === undefined || base.length > norm(best).length) best = key
  }
  return best === undefined ? undefined : map[best]
}

/** The map with one project's selection set, or removed when `sessionID` is undefined. */
export function withSelection(map: Record<string, string>, directory: string, sessionID: string | undefined) {
  const next = { ...map }
  if (sessionID === undefined) delete next[directory]
  else next[directory] = sessionID
  return next
}

// The sessions themselves and who holds them. The Browser tab publishes the list (sessions.json: it owns names and
// projects); the browser tool writes leases (leases.json: who controls a session). Two files, so neither side
// overwrites the other.

export const sessionsFile = (root: string) => path.join(root, "browser-profiles", "sessions.json")
export const leasesFile = (root: string) => path.join(root, "browser-profiles", "leases.json")

export interface SessionInfo {
  readonly id: string
  readonly name: string
  /** The directory of the project the session belongs to. */
  readonly project: string
  readonly group?: string
}

export interface Lease {
  readonly agent: string
  readonly since: number
}

/** Who holds a session while the operator is using Take control in the pane. */
export const OPERATOR = "operator"

export function parseSessions(text: string | undefined): SessionInfo[] {
  if (!text) return []
  try {
    const value = JSON.parse(text) as unknown
    if (!Array.isArray(value)) return []
    return value.flatMap((item): SessionInfo[] => {
      if (!item || typeof item !== "object") return []
      const { id, name, project, group } = item as Record<string, unknown>
      if (typeof id !== "string" || typeof name !== "string" || typeof project !== "string") return []
      return [{ id, name, project, ...(typeof group === "string" && group ? { group } : {}) }]
    })
  } catch {
    return []
  }
}

export function parseLeases(text: string | undefined): Record<string, Lease> {
  if (!text) return {}
  try {
    const value = JSON.parse(text) as unknown
    if (!value || typeof value !== "object" || Array.isArray(value)) return {}
    return Object.fromEntries(
      Object.entries(value).flatMap(([id, lease]): Array<[string, Lease]> => {
        const item = lease as { agent?: unknown; since?: unknown } | null
        return item && typeof item.agent === "string" && item.agent
          ? [[id, { agent: item.agent, since: typeof item.since === "number" ? item.since : 0 }]]
          : []
      }),
    )
  } catch {
    return {}
  }
}

/** The project directory that owns `directory` among the published sessions; the most specific one wins. */
export function projectOf(list: readonly SessionInfo[], directory: string): string | undefined {
  const target = norm(directory)
  let best: string | undefined
  for (const item of list) {
    const base = norm(item.project)
    if (target !== base && !target.startsWith(base + "/")) continue
    if (best === undefined || base.length > norm(best).length) best = item.project
  }
  return best
}

/** A session by id, or by name (the caller's project first). Says why when it cannot pick exactly one. */
export function resolve(
  list: readonly SessionInfo[],
  ref: string,
  directory: string,
): { session: SessionInfo } | { error: string } {
  const wanted = ref.trim()
  const byId = list.find((item) => item.id === wanted)
  if (byId) return { session: byId }
  const lower = wanted.toLowerCase()
  const named = list.filter((item) => item.name.toLowerCase() === lower)
  const own = projectOf(list, directory)
  const near = named.filter((item) => own !== undefined && norm(item.project) === norm(own))
  const pool = near.length > 0 ? near : named
  if (pool.length === 1) return { session: pool[0]! }
  if (pool.length > 1)
    return {
      error: `Several browser sessions are named "${wanted}": ${pool.map((item) => item.id).join(", ")}. Use the id.`,
    }
  return {
    error: `No browser session "${wanted}". Known: ${list.map((item) => `${item.name} (${item.id})`).join(", ") || "none"}.`,
  }
}

/**
 * Why `agent` may not act in a session right now, or undefined when it may. Reading is allowed while the operator
 * has control; anything else waits for them. A session assigned to another agent is that agent's alone.
 */
export function refusal(
  leases: Record<string, Lease>,
  sessionID: string,
  agent: string,
  acting: boolean,
): string | undefined {
  const lease = leases[sessionID]
  if (!lease) return undefined
  if (lease.agent === OPERATOR)
    return acting ? "The operator has taken control of this browser session. Wait until they release it." : undefined
  if (lease.agent.toLowerCase() === agent.toLowerCase()) return undefined
  return `This browser session is assigned to ${lease.agent}. Ask the orchestrator to reassign or release it.`
}

export function withLease(leases: Record<string, Lease>, sessionID: string, agent: string | undefined, now: number) {
  const next = { ...leases }
  if (agent === undefined) delete next[sessionID]
  else next[sessionID] = { agent, since: now }
  return next
}

/** One line per session for the agent: name, id, project, running or not, page, controller. */
export function describe(
  list: readonly SessionInfo[],
  leases: Record<string, Lease>,
  page: (id: string) => { running: boolean; title?: string; url?: string },
) {
  if (list.length === 0) return "No browser sessions exist. Ask the operator to add one in the Browser tab."
  return list
    .map((item) => {
      const state = page(item.id)
      const lease = leases[item.id]
      return `- ${item.name} [${item.id}] project ${item.project}${item.group ? ` group ${item.group}` : ""}: ${
        state.running ? `running${state.url ? `, ${state.title || "(no title)"} - ${state.url}` : ""}` : "not running"
      }; controller: ${lease ? lease.agent : "none"}`
    })
    .join("\n")
}
