import { expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { collector } from "@orchestra/core/credential-vault/windows"
const fake = () => {
  let killed = 0
  let args: string[] = []
  const child = new EventEmitter() as any
  child.stdout = new EventEmitter(); child.stdout.setEncoding = () => {}
  child.stderr = { resume() {} }
  child.stdin = new EventEmitter(); child.stdin.end = () => {}
  child.kill = () => { killed++; return true }
  return { child, killed: () => killed, args: () => args, launch: ((_exe: string, input: string[]) => { args = input; return child }) as any }
}
test("native wait is async, has a deadline, kills only its child, ignores late output", async () => {
  const f = fake()
  let ticks = 0
  const clock = setInterval(() => ticks++, 2)
  try {
    await expect(collector("win32", { launch: f.launch, timeoutMs: 25 }).collect()).rejects.toThrow("timed out")
    expect(ticks).toBeGreaterThan(1)
    expect(f.killed()).toBe(1)
    f.child.stdout.emit("data", "late output")
    f.child.emit("close", 0)
    expect(f.killed()).toBe(1)
    expect(f.args()).toContain("-EncodedCommand")
  } finally { clearInterval(clock) }
})
test("startup failure and operator cancellation settle without a saved value", async () => {
  const f = fake()
  await expect(collector("win32", { launch: f.launch, startupMs: 10 }).collect()).rejects.toThrow("window did not open")
  expect(f.killed()).toBe(1)
  const g = fake(); const abort = new AbortController()
  const pending = collector("win32", { launch: g.launch }).collect(undefined, abort.signal)
  abort.abort()
  expect(await pending).toBeUndefined()
  expect(g.killed()).toBe(1)
})
test("native SHOWN diagnostics are split-chunk safe and never exposes supplied secret values", async () => {
  const f = fake(); let ready = 0
  const pending = collector("win32", { launch: f.launch }).collect(undefined, undefined, () => ready++)
  f.child.stdout.emit("data", "ORCHESTRA_VAULT_SH")
  f.child.stdout.emit("data", 'OWN {"handle":42,"visible":true,"foreground":false,"x":0,"y":0,"width":460,"height":330}\r\n')
  expect(ready).toBe(1)
  f.child.emit("close", 0)
  expect(await pending).toBeUndefined()
  expect(f.killed()).toBe(0)
})

test("diagnostics reject any field outside numeric window geometry and visibility", async () => {
  const f = fake(); let callbacks = 0
  const pending = collector("win32", { launch: f.launch }).collect(undefined, undefined, () => callbacks++)
  f.child.stdout.emit("data", 'ORCHESTRA_VAULT_SHOWN {"handle":42,"visible":true,"foreground":true,"x":0,"y":0,"width":460,"height":330,"password":"should-never-be-diagnostic"}\n')
  await expect(pending).rejects.toThrow("secure input failed")
  expect(callbacks).toBe(0)
  expect(f.killed()).toBe(1)
})
