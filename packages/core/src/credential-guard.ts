export * as CredentialGuard from "./credential-guard.js"

import { createHash } from "node:crypto"
import { RoomRules } from "@orchestra/schema/room-rules"
import { RuleEnforce } from "./rule-enforce.js"

type Context = { sessionID: string; agent?: string }
export function record(value: string, context: Context, event: "refused" | "construction", log = RuleEnforce.log) {
  log({ layer: "hard", outcome: event === "refused" ? "refused" : "passed", session: context.sessionID,
    agent: context.agent ?? "", by: "built-in", rule: "credential-guard", what: JSON.stringify({
      event: `credential-guard.${event}`, assembled: RoomRules.foldLiteralPaths(value) !== value,
      encoded: /base64|atob|FromBase64String|['"]hex['"]|\\x[0-9a-f]{2}/i.test(value),
      sha256: createHash("sha256").update(value).digest("hex"),
    }) })
}
export function suspicious(command: string) {
  return RoomRules.foldLiteralPaths(command) !== command || /\b(?:atob|FromBase64String)\s*\(|Buffer\.from\(/i.test(command)
}
export function files(action: string, resources: readonly string[], context: Context, log = RuleEnforce.log) {
  if (!["read", "edit", "write", "patch", "apply_patch", "apply-patch", "multiedit", "delete", "remove", "rename", "move", "copy"].includes(action)) return false
  const protectedResources = resources.filter(resource => RoomRules.protectedFile(undefined, resource))
  for (const resource of protectedResources) record(resource, context, "refused", log)
  return protectedResources.length > 0
}
