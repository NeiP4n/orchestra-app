export * as BrowserKeyQueue from "./key-queue.js"

export interface Key {
  name: string
  sequence: string
  ctrl?: boolean
  meta?: boolean
  option?: boolean
}

/** Terminal event objects may be reused. Copy now, before any asynchronous Chrome lookup. */
export const snapshot = (key: Key): Key => ({
  name: key.name, sequence: key.sequence, ctrl: key.ctrl, meta: key.meta, option: key.option,
})

export function make() {
  const pending = new Map<string, Promise<unknown>>()
  return <T>(sessionID: string, input: Key, send: (key: Key) => Promise<T>): Promise<T> => {
    const key = snapshot(input)
    const previous = pending.get(sessionID) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(() => send(key))
    pending.set(sessionID, next)
    void next.finally(() => {
      if (pending.get(sessionID) === next) pending.delete(sessionID)
    }).catch(() => undefined)
    return next
  }
}
