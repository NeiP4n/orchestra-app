export * as BrowserWatch from "./watch.js"

import type { Client } from "./cdp.js"

// A page watcher for browser triggers: a MutationObserver inside the page reports rows that were added (a new chat
// message, a new list item) through a CDP binding. It reads what the page already shows; it calls no internal API of the
// site (no WhatsApp Store.Msg) and sends nothing. What arrives here is outside text: it is filtered, cut short and only
// ever reaches the Orchestrator inside an <untrusted> block (see trigger.ts).
//
// Filters, in the order they run: only positively identified incoming rows pass; the operator's and the agent's own actions mute the session
// for a few seconds; a row seen before is dropped (LRU of 2048); a batch of more than 8 rows is a history load, not news.

export const BINDING = "__orchestraWatch"
export const LRU_SIZE = 2048
export const MAX_ITEMS = 5
export const MAX_TEXT = 300
export const SESSION_PER_MINUTE = 30

export interface Item {
  readonly chat: string
  readonly text: string
}

export interface Event {
  readonly sessionID: string
  readonly items: readonly Item[]
  readonly at: number
}

export interface State {
  readonly seen: Map<string, true>
  readonly muted: Map<string, number>
  readonly accepted: Map<string, number[]>
}

export const makeState = (): State => ({ seen: new Map(), muted: new Map(), accepted: new Map() })

const state = makeState()

/** Drops what the page reports until `ms` from now: used around the agent's own actions and the operator's input. */
export function mute(sessionID: string, ms: number, now = Date.now(), target: State = state) {
  target.muted.set(sessionID, now + ms)
}

const clean = (value: unknown, max: number) =>
  typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : ""

/** Turns what the page reported into the items worth waking someone for. Never throws on bad input. */
export function accept(sessionID: string, payload: string, now = Date.now(), target: State = state): Item[] {
  if ((target.muted.get(sessionID) ?? 0) > now) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  } catch {
    return []
  }
  const raw = (parsed as { items?: unknown } | null)?.items
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 8) return []
  const found: Item[] = []
  for (const entry of raw.slice(-MAX_ITEMS)) {
    if (typeof entry !== "object" || entry === null) continue
    const row = entry as { chat?: unknown; text?: unknown; out?: unknown }
    if (row.out !== false) continue
    const text = clean(row.text, MAX_TEXT)
    if (!text) continue
    const chat = clean(row.chat, 80)
    const key = `${sessionID}\u0000${chat}\u0000${text}`
    if (target.seen.has(key)) {
      target.seen.delete(key)
      target.seen.set(key, true)
      continue
    }
    target.seen.set(key, true)
    if (target.seen.size > LRU_SIZE) target.seen.delete(target.seen.keys().next().value as string)
    found.push({ chat, text })
  }
  if (found.length === 0) return []
  const recent = (target.accepted.get(sessionID) ?? []).filter((at) => at > now - 60_000)
  if (recent.length + found.length > SESSION_PER_MINUTE) {
    target.accepted.set(sessionID, recent)
    return []
  }
  target.accepted.set(sessionID, [...recent, ...found.map(() => now)])
  return found
}

type Listener = (event: Event) => void
const listeners = new Set<Listener>()

export function onEvent(listener: Listener) {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}

export function handle(sessionID: string, payload: string, now = Date.now()) {
  const items = accept(sessionID, payload, now)
  if (items.length === 0) return
  for (const listener of listeners) listener({ sessionID, items, at: now })
}

let ensurer: ((sessionID: string) => Promise<boolean>) | undefined

/** The browser runtime registers how a session gets (re)armed; the trigger sweep calls ensure() without importing it. */
export const setEnsurer = (next: (sessionID: string) => Promise<boolean>) => void (ensurer = next)

export const ensure = async (sessionID: string) => (ensurer ? await ensurer(sessionID).catch(() => false) : false)

/** The script that runs in the page. It reports added rows after a one second pause, and nothing for the first 3 seconds. */
export function script(binding = BINDING) {
  return `(() => {
  if (window.__orchestraWatchOn && window.__orchestraWatchObserver) return
  window.__orchestraWatchOn = true
  const quietUntil = Date.now() + 3000
  const rowSel = '[data-id],[role="row"],[role="listitem"],article,li'
  const clean = (s) => String(s || '').replace(/\\s+/g, ' ').trim()
  const chatName = () => {
    const h = document.querySelector('#main header span[title]')
    return clean((h && (h.getAttribute('title') || h.textContent)) || document.title).slice(0, 80)
  }
  const incoming = (el) => {
    const id = (el.getAttribute && el.getAttribute('data-id')) || ''
    const outSel = '.message-out,[data-outgoing="true"],[data-direction="out"],[data-icon="tail-out"],[data-testid="tail-out"]'
    // Unknown direction is not incoming. Explicit outgoing evidence always wins,
    // including contradictory markers; an absent delivery icon proves nothing.
    if (/^true_/.test(id) || el.closest(outSel) || el.querySelector(outSel)) return false
    return /^false_/.test(id) || !!el.closest('.message-in,[data-outgoing="false"],[data-direction="in"]') || !!el.querySelector('[data-icon="tail-in"],[data-testid="tail-in"]')
  }
  let batch = []
  let timer = 0
  const consider = (node) => {
    if (!(node instanceof Element)) return
    const row = node.matches(rowSel) ? node : node.closest(rowSel)
    const rows = row ? [row] : Array.from(node.querySelectorAll(rowSel)).slice(0, 20)
    for (const r of rows) {
      if (!incoming(r)) continue
      const text = clean(r.innerText || r.textContent).slice(0, 400)
      if (text) batch.push({ chat: chatName(), text, out: false })
    }
  }
  const flush = () => {
    timer = 0
    const items = batch
    batch = []
    if (Date.now() < quietUntil || items.length === 0 || items.length > 8) return
    try { window[${JSON.stringify(binding)}](JSON.stringify({ items: items.slice(-5), at: Date.now() })) } catch (e) {}
  }
  const start = () => {
    window.__orchestraWatchObserver = new MutationObserver((records) => {
      for (const record of records) for (const node of record.addedNodes) consider(node)
      if (batch.length > 0 && !timer) timer = setTimeout(flush, 1000)
    })
    window.__orchestraWatchObserver.observe(document.documentElement, { childList: true, subtree: true })
  }
  if (document.documentElement) start()
  else document.addEventListener('DOMContentLoaded', start, { once: true })
})()`
}

const installed = new WeakMap<Client, { stop: () => void; identifier?: string }>()
export async function uninstall(client: Client) {
  const item = installed.get(client)
  if (!item) return
  item.stop(); installed.delete(client)
  await client.send("Runtime.evaluate", { expression: "window.__orchestraWatchObserver?.disconnect(); window.__orchestraWatchOn = false", returnByValue: true }).catch(() => undefined)
  if (item.identifier) await client.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: item.identifier }).catch(() => undefined)
  await client.send("Runtime.removeBinding", { name: BINDING }).catch(() => undefined)
}

/** Arms one page connection: the binding, the script for every new document, and the script for the page already open. */
export async function install(sessionID: string, client: Client) {
  if (installed.has(client)) {
    // Navigation can race document-start injection. Re-evaluate our fixed observer,
    // whose page flag makes this idempotent, without duplicating binding listeners.
    await client.send("Runtime.evaluate", { expression: script(), returnByValue: true })
    return
  }
  await client.send("Page.enable")
  await client.send("Runtime.enable")
  await client.send("Runtime.addBinding", { name: BINDING })
  const added = await client.send<{ identifier?: string }>("Page.addScriptToEvaluateOnNewDocument", { source: script() })
  const stop = client.on("Runtime.bindingCalled", (params) => {
    if (params?.name !== BINDING) return
    handle(sessionID, String(params.payload ?? ""))
  })
  installed.set(client, { stop, identifier: added?.identifier })
  try { await client.send("Runtime.evaluate", { expression: script(), returnByValue: true }) }
  catch (error) { await uninstall(client); throw error }
}

/** Fixed read-only readiness probe. It never returns page text or auth information. */
export async function ready(client: Client): Promise<boolean> {
  const result = await client.send<{ result?: { value?: boolean }; exceptionDetails?: unknown }>("Runtime.evaluate", {
    expression: "Boolean(document.documentElement && window.__orchestraWatchOn && window.__orchestraWatchObserver)", returnByValue: true,
  })
  return !result.exceptionDetails && result.result?.value === true
}
