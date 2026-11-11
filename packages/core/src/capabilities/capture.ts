export * as CapabilityCapture from "./capture.js"
import { createHash } from "node:crypto"
import { Effect } from "effect"
import type { KV } from "../kv.js"
import { OutcomeLedger } from "./outcome-ledger.js"
import { nativeGroup, type Group } from "./registry.js"

export interface Call {
  sessionID: string
  messageID: string
  id: string
  tool: string
  agent: string
}
export interface Attribution {
  projectID: string
  adapterID: string
  capability: Group
}
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
/** Records completed call observations, NOT task acceptance. Interrupted calls without an after
 * event are not observed. All tokens/cost remain unknown; these rows cannot earn efficiency scores.
 * No arguments, output, errors, credentials, or claims of success enter persistence. */
export function make(kv: Pick<KV.Interface, "get" | "atomicUpdate">, clock = Date.now) {
  const pending = new Map<string, { scope: OutcomeLedger.Scope; attempt: OutcomeLedger.Attempt }>()
  const ledger = OutcomeLedger.make(kv)
  const identity = (call: Call) => digest([call.sessionID, call.messageID, call.id])
  return {
    begin: (call: Call, attribution: Attribution) =>
      Effect.sync(() => {
        const at = clock()
        for (const [key, row] of pending) if (at - row.attempt.at > 3600000) pending.delete(key)
        if (pending.size >= 10000) return
        const key = identity(call)
        if (pending.has(key)) return
        pending.set(key, {
          scope: { projectID: attribution.projectID, role: call.agent, capability: attribution.capability },
          attempt: {
            id: key,
            taskID: digest([call.sessionID, call.messageID]),
            toolID: attribution.adapterID,
            at,
            latencyMs: 0,
            outputTokens: null,
            costUsd: null,
          },
        })
      }),
    end: (call: Call) =>
      Effect.suspend(() => {
        const key = identity(call),
          row = pending.get(key)
        if (!row) return Effect.void
        pending.delete(key)
        return ledger.record(row.scope, { ...row.attempt, latencyMs: Math.max(0, clock() - row.attempt.at) })
      }),
    pendingCount: () => pending.size,
  }
}
export const localAttribution = (projectID: string, name: string): Attribution => ({
  projectID,
  adapterID: "native:" + name,
  capability: nativeGroup(name),
})
