export * as BrowserWatchRecovery from "./watch-recovery.js"

/** One restore attempt per outage, not per process lifetime. Concurrent sweeps share it. */
export function make() {
  const attempted = new Set<string>()
  const pending = new Map<string, Promise<boolean>>()
  const reset = (id: string) => attempted.delete(id)
  const restore = (
    id: string,
    io: {
      ensure: () => Promise<boolean>
      stopped: () => boolean
      open: () => Promise<unknown>
      failed: (error: unknown) => void
    },
  ): Promise<boolean> => {
    const active = pending.get(id)
    if (active) return active
    const work = (async () => {
      if (await io.ensure()) {
        reset(id)
        return true
      }
      if (io.stopped() || attempted.has(id)) return false
      attempted.add(id)
      try {
        await io.open()
        if (!(await io.ensure()))
          throw new Error("Страница не готова к наблюдению. Откройте сохранённую страницу и проверьте вход в аккаунт.")
        reset(id)
        return true
      } catch (error) {
        io.failed(error)
        return false
      }
    })().finally(() => {
      if (pending.get(id) === work) pending.delete(id)
    })
    pending.set(id, work)
    return work
  }
  return { restore, reset }
}
