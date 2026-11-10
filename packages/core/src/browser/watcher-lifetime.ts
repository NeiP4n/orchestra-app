export * as BrowserWatcherLifetime from "./watcher-lifetime.js"
import { BrowserBridge } from "./bridge.js"

/** Drop an observer only after its final enabled owner stops needing it. Never close Chrome. */
export async function release(input: {
  sessionID: string
  projectID: string
  directory: string
  sessions: readonly BrowserBridge.SessionInfo[]
  triggers: readonly { enabled: boolean; kind: string; spec: string }[]
  stop: (sessionID: string) => Promise<void>
}): Promise<boolean> {
  if (BrowserBridge.ownerRefusal(input.sessions, input.sessionID, input.directory, input.projectID)) return false
  if (input.triggers.some((other) => other.enabled && other.kind === "browser" && other.spec === input.sessionID))
    return false
  await input.stop(input.sessionID)
  return true
}
