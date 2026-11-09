export * as TriggerDelivery from "./trigger-delivery.js"
import { createHash } from "node:crypto"
import { Effect } from "effect"
import type { KV } from "./kv.js"
import { Trigger } from "./trigger.js"

export const LEASE_MS = 300_000
export const leaseKey = (kind: string) => `orchestra/trigger-sweeper/${kind}`
export function lease(current: unknown, owner: string, now: number) {
  const row = current as { owner?: string; until?: number } | undefined
  return row?.owner && row.owner !== owner && Number(row.until) > now ? { owner: row.owner, until: Number(row.until) } : { owner, until: now + LEASE_MS }
}
export const acquire = (kv: KV.Interface, kind: string, owner: string, now: number) => kv.atomicUpdate(leaseKey(kind), (current) => lease(current, owner, now) as never).pipe(Effect.map((row) => (row as { owner?: string })?.owner === owner))
export const release = (kv: KV.Interface, kind: string, owner: string) => kv.atomicUpdate(leaseKey(kind), (current) => (current as { owner?: string })?.owner === owner ? undefined : current)
export interface Pending {
  fireId: string
  messageID: string
  scheduledAt: number
  firedAt: number
  /** Only fixed operator instruction/time triggers. Browser payloads stay volatile. */
  source: Trigger.Info
}
export const fireID = (id: string, scheduledAt: number) => `${id}:${scheduledAt}`
export const messageID = (fireId: string) => `msg_trigger_${createHash("sha256").update(fireId).digest("hex")}`
/** Single-key transaction reserves the due slot and durable delivery together. */
export function reserve(current: unknown, expected: Trigger.Info, now: number, timezone: string): unknown {
  const trigger = Trigger.parse(current)
  if (!trigger || trigger.pendingFire || trigger.nextAt !== expected.nextAt || Trigger.due(trigger, now) !== "fire") return current
  const scheduledAt = trigger.nextAt!
  const fireId = fireID(trigger.id, scheduledAt)
  return { ...Trigger.afterFire(trigger, now, timezone), pendingFire: { fireId, messageID: messageID(fireId), scheduledAt, firedAt: now, source: trigger } satisfies Pending }
}
/** Clear only this exact fire. An edit/delete/new reservation must never be overwritten. */
export function acknowledge(current: unknown, fireId: string): unknown {
  const trigger = Trigger.parse(current)
  if (trigger?.pendingFire?.fireId !== fireId) return current
  const { pendingFire, ...rest } = trigger
  return rest
}
