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
