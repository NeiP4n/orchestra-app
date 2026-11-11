import { createSignal, onCleanup, onMount } from "solid-js"

export interface ContinuationAccess {
  get: () => Promise<{ enabled: boolean }>
  set: (value: { enabled: boolean }) => Promise<{ enabled: boolean }>
  onState?: (receive: (value: { enabled: boolean }) => void) => () => void
  onReconnect?: (refresh: () => void) => () => void
}

/** Server-owned state. Never show an optimistic stop before execution cleanup settles. */
export function createContinuationControl(access: ContinuationAccess) {
  const [enabled, setEnabled] = createSignal<boolean>()
  const [busy, setBusy] = createSignal(false)
  const [failed, setFailed] = createSignal(false)
  let revision = 0
  let alive = true
  const refresh = async () => {
    const at = ++revision
    try {
      const value = await access.get()
      if (alive && at === revision) {
        setEnabled(value.enabled)
        setFailed(false)
      }
    } catch {
      if (alive && at === revision) {
        setEnabled(undefined)
        setFailed(true)
      }
    }
  }
  onMount(() => {
    void refresh()
  })
  if (access.onState)
    onCleanup(
      access.onState((value) => {
        revision++
        setEnabled(value.enabled)
        setFailed(false)
      }),
    )
  if (access.onReconnect)
    onCleanup(
      access.onReconnect(() => {
        void refresh()
      }),
    )
  onCleanup(() => {
    alive = false
    revision++
  })
  return {
    enabled,
    busy,
    failed,
    refresh,
    toggle: async () => {
      const current = enabled()
      if (current === undefined || busy()) return
      setBusy(true)
      setFailed(false)
      const at = ++revision
      try {
        const value = await access.set({ enabled: !current })
        if (alive && at === revision) {
          setEnabled(value.enabled)
          setFailed(false)
        }
      } catch {
        if (alive) {
          await refresh()
          setFailed(true)
        }
      } finally {
        if (alive) setBusy(false)
      }
    },
  }
}
