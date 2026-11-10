import { test, expect } from "bun:test"
import { BrowserWatchRecovery } from "@orchestra/core/browser/watch-recovery"

test("each recovered browser can recover a later independent crash, without duplicate launches", async () => {
  const recovery = BrowserWatchRecovery.make()
  let healthy = false,
    starts = 0
  const io = {
    ensure: async () => healthy,
    stopped: () => false,
    open: async () => {
      starts++
      healthy = true
    },
    failed: () => {
      throw Error("unexpected")
    },
  }
  expect(await Promise.all([recovery.restore("A", io), recovery.restore("A", io)])).toEqual([true, true])
  expect(starts).toBe(1)
  healthy = false
  expect(await recovery.restore("A", io)).toBe(true)
  expect(starts).toBe(2)
})
test("failed outage attempts are not retried every sweep; a healthy reconnect or explicit activation resets the gate", async () => {
  const recovery = BrowserWatchRecovery.make()
  let starts = 0,
    healthy = false,
    failures = 0
  const io = {
    ensure: async () => healthy,
    stopped: () => false,
    open: async () => {
      starts++
      throw Error("crashed")
    },
    failed: () => {
      failures++
    },
  }
  for (let n = 0; n < 5; n++) expect(await recovery.restore("A", io)).toBe(false)
  expect(starts).toBe(1)
  expect(failures).toBe(1)
  healthy = true
  expect(await recovery.restore("A", io)).toBe(true)
  healthy = false
  expect(await recovery.restore("A", io)).toBe(false)
  expect(starts).toBe(2)
  recovery.reset("A")
  expect(await recovery.restore("A", io)).toBe(false)
  expect(starts).toBe(3)
})
test("operator stop wins even in a fresh service controller; sessions recover independently", async () => {
  const recovery = BrowserWatchRecovery.make()
  let starts = 0
  const io = {
    ensure: async () => false,
    stopped: () => true,
    open: async () => {
      starts++
    },
    failed: () => {},
  }
  expect(await recovery.restore("A", io)).toBe(false)
  expect(starts).toBe(0)
  expect(await recovery.restore("B", { ...io, stopped: () => false })).toBe(false)
  expect(starts).toBe(1)
})
