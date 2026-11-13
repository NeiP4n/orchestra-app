import { expect, spyOn, test } from "bun:test"
import * as persistence from "../../src/util/persistence"
import { renderLocal } from "../fixture/local"

test("shutdown waits for pin writes and preserves the last pin order", async () => {
  const finalizers = new Set<() => Promise<void>>()
  const releases: (() => void)[] = []
  const writes: unknown[] = []
  const write = spyOn(persistence, "writeJsonAtomic").mockImplementation(async (file, value) => {
    if (!file.endsWith("session.json")) return
    writes.push(JSON.parse(JSON.stringify(value)))
    await new Promise<void>(resolve => releases.push(resolve))
  })
  const setup = await renderLocal({ lifecycle: { add(finalizer) {
    finalizers.add(finalizer)
    return () => finalizers.delete(finalizer)
  } } })
  try {
    await setup.waitFor(() => setup.local.session.ready)
    setup.local.session.togglePin("ses_first")
    setup.local.session.togglePin("ses_second")
    expect(finalizers.size).toBeGreaterThan(0)
    let flushed = false
    const flush = Promise.all([...finalizers].map(finalizer => finalizer())).then(() => { flushed = true })
    await setup.waitFor(() => writes.length > 0)
    expect(flushed).toBe(false)
    expect(writes).toEqual([{ pinned: ["ses_first"] }])
    releases.shift()!()
    await setup.waitFor(() => writes.length === 2)
    expect(flushed).toBe(false)
    expect(writes[1]).toEqual({ pinned: ["ses_first", "ses_second"] })
    releases.shift()!()
    await flush
    expect(flushed).toBe(true)
  } finally {
    releases.splice(0).forEach(release => release())
    await Promise.allSettled([...finalizers].map(finalizer => finalizer()))
    await setup[Symbol.asyncDispose]()
    write.mockRestore()
  }
})


test("shutdown flushes real pin snapshots before their state directory is removed", async () => {
  const finalizers = new Set<() => Promise<void>>()
  const setup = await renderLocal({ lifecycle: { add(finalizer) {
    finalizers.add(finalizer)
    return () => finalizers.delete(finalizer)
  } } })
  try {
    await setup.waitFor(() => setup.local.session.ready)
    for (let index = 0; index < 12; index++) setup.local.session.togglePin(`ses_${index}`)
    setup.local.session.togglePin("ses_0")
    setup.renderer.destroy()
    await Promise.all([...finalizers].map(finalizer => finalizer()))
    const saved = await Bun.file(`${setup.state}/session.json`).json()
    expect(saved.pinned).toEqual(Array.from({ length: 11 }, (_, index) => `ses_${index + 1}`))
  } finally { await setup[Symbol.asyncDispose]() }
})

test("a failed pin write does not prevent a later snapshot from being saved", async () => {
  const finalizers = new Set<() => Promise<void>>()
  let attempts = 0
  const writes: unknown[] = []
  const report = spyOn(console, "error").mockImplementation(() => {})
  const write = spyOn(persistence, "writeJsonAtomic").mockImplementation(async (file, value) => {
    if (!file.endsWith("session.json")) return
    if (++attempts === 1) throw new Error("fixture disk failure")
    writes.push(JSON.parse(JSON.stringify(value)))
  })
  const setup = await renderLocal({ lifecycle: { add(finalizer) {
    finalizers.add(finalizer)
    return () => finalizers.delete(finalizer)
  } } })
  try {
    await setup.waitFor(() => setup.local.session.ready)
    setup.local.session.togglePin("ses_first")
    await setup.waitFor(() => report.mock.calls.length > 0)
    setup.local.session.togglePin("ses_second")
    await Promise.all([...finalizers].map(finalizer => finalizer()))
    expect(attempts).toBe(2)
    expect(writes).toEqual([{ pinned: ["ses_first", "ses_second"] }])
  } finally {
    await setup[Symbol.asyncDispose]()
    write.mockRestore()
    report.mockRestore()
  }
})
