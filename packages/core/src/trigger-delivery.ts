export * as TriggerDelivery from "./trigger-delivery.js"
import { createHash } from "node:crypto"
import { Effect } from "effect"
import type { KV } from "./kv.js"
import { Trigger } from "./trigger.js"

export const LEASE_MS = 300_000
export const leaseKey = (kind: string) => `orchestra/trigger-sweeper/${kind}`
export function lease(current: unknown, owner: string, now: number) {
  const row = current as { owner?: string; until?: number } | undefined
  return row?.owner && row.owner !== owner && Number(row.until) > now
    ? { owner: row.owner, until: Number(row.until) }
    : { owner, until: now + LEASE_MS }
}
export const acquire = (kv: KV.Interface, kind: string, owner: string, now: number) =>
  kv
    .atomicUpdate(leaseKey(kind), (current) => lease(current, owner, now) as never)
    .pipe(Effect.map((row) => (row as { owner?: string })?.owner === owner))
export const release = (kv: KV.Interface, kind: string, owner: string) =>
  kv.atomicUpdate(leaseKey(kind), (current) => ((current as { owner?: string })?.owner === owner ? undefined : current))
export interface Pending {
  fireId: string
  messageID: string
  destination: string
  scheduledAt: number
  firedAt: number
  /** Original reviewed trigger. Page rows, when present, remain separate untrusted data. */
  source: Trigger.Info
  rows?: Trigger.Row[]
}
export const fireID = (id: string, scheduledAt: number) => `${id}:${scheduledAt}`
export const messageID = (fireId: string) => `msg_trigger_${createHash("sha256").update(fireId).digest("hex")}`
/** Single-key transaction reserves the due slot and durable delivery together. */
export function reserve(
  current: unknown,
  expected: Trigger.Info,
  now: number,
  timezone: string,
  destination: string,
): unknown {
  const trigger = Trigger.parse(current)
  if (!trigger || trigger.pendingFire || trigger.nextAt !== expected.nextAt || Trigger.due(trigger, now) !== "fire")
    return current
  const scheduledAt = trigger.nextAt!
  const fireId = fireID(trigger.id, scheduledAt)
  return {
    ...Trigger.afterFire(trigger, now, timezone),
    pendingFire: {
      fireId,
      messageID: messageID(fireId),
      destination,
      scheduledAt,
      firedAt: now,
      source: trigger,
    } satisfies Pending,
  }
}
/** Clear only this exact fire. An edit/delete/new reservation must never be overwritten. */
export function acknowledge(current: unknown, fireId: string): unknown {
  const trigger = Trigger.parse(current)
  if (trigger?.pendingFire?.fireId !== fireId) return current
  const { pendingFire, ...rest } = trigger
  return rest
}

/** Browser reservation and counter advance share one durable transaction. Replay keeps the same inbox id. */
export function reserveBrowser(
  current: unknown,
  now: number,
  destination: string,
  rows?: readonly Trigger.Row[],
): unknown {
  const trigger = Trigger.parse(current)
  rows ??= trigger?.browserQueue?.rows ?? []
  if (!trigger || trigger.pendingFire || Trigger.browserDue(trigger, now) !== "fire" || rows.length === 0)
    return current
  const fireId = fireID(trigger.id, now)
  return {
    ...Trigger.afterFire(trigger, now),
    ...(trigger.browserQueue ? { browserQueue: { ...trigger.browserQueue, rows: [] } } : {}),
    pendingFire: {
      fireId,
      messageID: messageID(fireId),
      destination,
      scheduledAt: now,
      firedAt: now,
      source: { ...trigger, browserQueue: undefined, publishApproved: false, browserSessionID: undefined },
      rows: rows
        .slice(-Trigger.MAX_PENDING)
        .map((row) => ({ chat: row.chat.slice(0, 300), text: row.text.slice(0, 300) })),
    } satisfies Pending,
  }
}

export interface BrowserQueue {
  rows: Trigger.Row[]
  eventIDs: string[]
  droppedRows: number
}
/** Accept only an exact live source. Replayed ingress after a partial KV failure cannot append twice. */
export function enqueueBrowser(
  current: unknown,
  event: { sessionID: string; at: number; items: readonly Trigger.Row[] },
): unknown {
  const trigger = Trigger.parse(current)
  if (!trigger || trigger.kind !== "browser" || !trigger.enabled || trigger.spec !== event.sessionID) return current
  const eventID = createHash("sha256")
    .update(JSON.stringify([event.sessionID, event.at, event.items]))
    .digest("hex")
  if (trigger.browserQueue?.eventIDs.includes(eventID)) return current
  const incoming = event.items
    .filter((row) => Trigger.matches(trigger, event.sessionID, row))
    .map((row) => ({ chat: row.chat.slice(0, 300), text: row.text.slice(0, 300) }))
  if (!incoming.length) return current
  const rows = [...(trigger.browserQueue?.rows ?? []), ...incoming]
  return {
    ...trigger,
    browserQueue: {
      rows: rows.slice(-Trigger.MAX_PENDING),
      eventIDs: [...(trigger.browserQueue?.eventIDs ?? []), eventID].slice(-32),
      droppedRows: (trigger.browserQueue?.droppedRows ?? 0) + Math.max(0, rows.length - Trigger.MAX_PENDING),
    } satisfies BrowserQueue,
  }
}
