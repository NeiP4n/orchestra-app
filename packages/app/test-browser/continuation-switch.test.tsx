import { expect, test } from "bun:test"
import { render } from "solid-js/web"
import { createContinuationControl, type ContinuationAccess } from "@orchestra/client/solid"

const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

test("stale initial read cannot overwrite a newer server event; failed write refreshes actual state", async () => {
  let receive!: (state: { enabled: boolean }) => void
  let resolve!: (state: { enabled: boolean }) => void
  let control!: ReturnType<typeof createContinuationControl>
  let reads = 0

  const access: ContinuationAccess = {
    get: () =>
      ++reads === 1
        ? new Promise((done) => {
            resolve = done
          })
        : Promise.resolve({ enabled: false }),
    set: async () => {
      throw new Error("lost response")
    },
    onState: (fn) => {
      receive = fn

      return () => {}
    },
  }

  const dispose = render(() => {
    control = createContinuationControl(access)

    return null
  }, document.createElement("div"))

  try {
    await flush()
    receive({ enabled: true })
    resolve({ enabled: false })
    await flush()
    expect(control.enabled()).toBe(true)
    await control.toggle()
    expect(control.enabled()).toBe(false)
    expect(control.failed()).toBe(true)
    expect(control.busy()).toBe(false)
  } finally {
    dispose()
  }
})
