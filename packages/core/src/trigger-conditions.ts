export * as TriggerConditions from "./trigger-conditions.js"
export type Condition =
  | { type: "time"; kind: "cron" | "interval" | "once"; spec: string }
  | { type: "browser"; event: "incoming-row"; sessionID: string; match?: string }
  | { type: "orchestra"; event: "execution.succeeded" | "execution.failed"; sessionID: string }
export function parse(value: unknown): Condition | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const v = value as Record<string, unknown>
  if (v.type === "time" && ["cron", "interval", "once"].includes(String(v.kind)) && typeof v.spec === "string" && Object.keys(v).every((k) => ["type", "kind", "spec"].includes(k))) return { type: "time", kind: v.kind as "cron" | "interval" | "once", spec: v.spec }
  if (typeof v.sessionID !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(v.sessionID)) return undefined
  if (v.type === "browser" && v.event === "incoming-row" && (v.match === undefined || typeof v.match === "string") && Object.keys(v).every((k) => ["type", "event", "sessionID", "match"].includes(k))) return { type: "browser", event: "incoming-row", sessionID: v.sessionID, ...(typeof v.match === "string" ? { match: v.match } : {}) }
  if (v.type === "orchestra" && ["execution.succeeded", "execution.failed"].includes(String(v.event)) && Object.keys(v).every((k) => ["type", "event", "sessionID"].includes(k))) return { type: "orchestra", event: v.event as "execution.succeeded" | "execution.failed", sessionID: v.sessionID }
  return undefined
}
