import { describe, expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import { Dod } from "@orchestra/core/dod"
import { tmpdir } from "./fixture/tmpdir"

const FILE = `task_id: G-1
stages: []
leaves:
  - id: B-1
    what: "Build one"
    group: "Build"
    task_state: NOT_STARTED
    steps:
      - "[ ] one"

  - id: B-2
    what: "Build two"
    group: "Build"
    task_state: NOT_STARTED
    steps:
      - "[ ] two"
`

const DONE_FILE = `task_id: G-1
stages: []
leaves:
  - id: B-1
    what: "Build one"
    group: "Build"
    task_state: DONE
    owner: "Alex"
    owner_id: "g-alex"
    taken_at: "2026-11-07T00:00:00.000Z"
    lease_until: "2026-11-07T00:05:00.000Z"
    steps:
      - "[x] one"
`

async function project(text = FILE) {
  const dir = await tmpdir()
  await mkdir(path.join(dir.path, ".orchestra"), { recursive: true })
  await Bun.write(path.join(dir.path, Dod.FILE), text)
  return dir
}

const alex = { id: "g-alex", name: "Alex" }
const cy = { id: "g-cy", name: "Cy" }

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)
const fails = <A>(effect: Effect.Effect<A, Dod.DodError>) =>
  Effect.runPromise(Effect.flip(effect)).then((error) => error.message)

async function readFile(dirPath: string) {
  return Bun.file(path.join(dirPath, Dod.FILE)).text()
}

// Moves one item's lease to the given time, as if its five minutes ran out — or,
// for a near-future time, as if it were about to run out.
async function setLeaseOf(dirPath: string, id: string, iso: string) {
  const text = await readFile(dirPath)
  const at = text.indexOf(`id: ${id}`)
  const next = text.indexOf("- id:", at + 1)
  const block = text.slice(at, next < 0 ? undefined : next)
  const replaced = block.replace(/lease_until: "[^"]+"/, `lease_until: "${iso}"`)
  expect(replaced).not.toBe(block)
  await Bun.write(path.join(dirPath, Dod.FILE), text.slice(0, at) + replaced + (next < 0 ? "" : text.slice(next)))
}

async function expireLeaseOf(dirPath: string, id: string) {
  return setLeaseOf(dirPath, id, "2000-01-01T00:00:00.000Z")
}

function leaseOf(text: string, id: string) {
  const at = text.indexOf(`id: ${id}`)
  const block = text.slice(at, text.indexOf("- id:", at + 1) < 0 ? undefined : text.indexOf("- id:", at + 1))
  return /lease_until: "([^"]+)"/.exec(block)?.[1]
}

describe("Dod lease heartbeat: session activity renews the lease", () => {
  test("heartbeat renews the holder's lease, even once it expired", async () => {
    await using dir = await project()
    await run(Dod.take({ directory: dir.path, id: "B-1", owner: alex }))
    await expireLeaseOf(dir.path, "B-1")
    expect((await run(Dod.read(dir.path))).items.find((entry) => entry.id === "B-1")).toMatchObject({ stale: true })
    const before = Date.now()
    await run(Dod.heartbeat({ directory: dir.path, id: "B-1", owner: alex }))
    const until = Date.parse(leaseOf(await readFile(dir.path), "B-1")!)
    expect(until).toBeGreaterThanOrEqual(before + Dod.LEASE_MS - 1000)
    expect(until).toBeLessThanOrEqual(Date.now() + Dod.LEASE_MS)
    expect((await run(Dod.read(dir.path))).items.find((entry) => entry.id === "B-1")).not.toMatchObject({
      stale: true,
    })
  })

  test("heartbeat refuses a non-holder and a finished item", async () => {
    await using dir = await project()
    await run(Dod.take({ directory: dir.path, id: "B-1", owner: alex }))
    expect(await fails(Dod.heartbeat({ directory: dir.path, id: "B-1", owner: cy }))).toBe("B-1 is taken by Alex")
    await using done = await project(DONE_FILE)
    expect(await fails(Dod.heartbeat({ directory: done.path, id: "B-1", owner: alex }))).toBe("B-1 is already done")
  })

  test("heartbeatHeld renews only due leases and writes nothing when nothing is due", async () => {
    await using dir = await project()
    await run(Dod.take({ directory: dir.path, id: "B-1", owner: alex }))
    await run(Dod.take({ directory: dir.path, id: "B-2", owner: alex }))
    // B-1 has a minute left — due. B-2 has five — not due.
    await setLeaseOf(dir.path, "B-1", new Date(Date.now() + 60_000).toISOString())
    const before = await readFile(dir.path)
    const renewed = await run(Dod.heartbeatHeld({ directory: dir.path, owner: alex }))
    expect(renewed).toEqual(["B-1"])
    const after = await readFile(dir.path)
    expect(Date.parse(leaseOf(after, "B-1")!)).toBeGreaterThan(Date.now() + Dod.LEASE_MS - 1000)
    expect(leaseOf(after, "B-2")).toBe(leaseOf(before, "B-2"))
    expect(await run(Dod.heartbeatHeld({ directory: dir.path, owner: alex }))).toEqual([])
    expect(await readFile(dir.path)).toBe(after)
  })

  test("heartbeatHeld renews an expired-but-still-held lease", async () => {
    await using dir = await project()
    await run(Dod.take({ directory: dir.path, id: "B-1", owner: alex }))
    await expireLeaseOf(dir.path, "B-1")
    expect(await run(Dod.heartbeatHeld({ directory: dir.path, owner: alex }))).toEqual(["B-1"])
    expect((await run(Dod.read(dir.path))).items.find((entry) => entry.id === "B-1")).not.toMatchObject({
      stale: true,
    })
  })

  test("heartbeatHeld on a project without a board renews nothing", async () => {
    await using dir = await tmpdir()
    expect(await run(Dod.heartbeatHeld({ directory: dir.path, owner: alex }))).toEqual([])
  })

  test("a running holder's item never reads stale, even past its lease", async () => {
    await using dir = await project()
    await run(Dod.take({ directory: dir.path, id: "B-1", owner: alex }))
    await expireLeaseOf(dir.path, "B-1")
    const running = () => true
    expect(
      (await run(Dod.read(dir.path, undefined, running))).items.find((entry) => entry.id === "B-1"),
    ).not.toMatchObject({ stale: true })
    // The lease ran out, but the holder's session is still working: no takeover.
    expect(await fails(Dod.take({ directory: dir.path, id: "B-1", owner: cy, active: running }))).toBe(
      "B-1 is taken by Alex",
    )
    const idle = () => false
    expect((await run(Dod.read(dir.path, undefined, idle))).items.find((entry) => entry.id === "B-1")).toMatchObject({
      stale: true,
    })
    const taken = await run(Dod.take({ directory: dir.path, id: "B-1", owner: cy, active: idle }))
    expect(taken.items.find((entry) => entry.id === "B-1")).toMatchObject({ owner: "Cy" })
  })

  test("check threads session activity: a running holder cannot lose its item to a check", async () => {
    await using dir = await project()
    await run(Dod.take({ directory: dir.path, id: "B-1", owner: alex }))
    await expireLeaseOf(dir.path, "B-1")
    const running = () => true
    expect(
      await fails(Dod.check({ directory: dir.path, id: "B-1", step: 1, checked: true, owner: cy, active: running })),
    ).toBe("B-1 is taken by Alex")
    // The same check once the holder is idle claims the stale item, as before.
    const claimed = await run(
      Dod.check({ directory: dir.path, id: "B-1", step: 1, checked: true, owner: cy, active: () => false }),
    )
    expect(claimed.items.find((entry) => entry.id === "B-1")).toMatchObject({ owner: "Cy" })
  })

  test("release threads session activity: a running holder's item cannot be freed by a stranger", async () => {
    await using dir = await project()
    await run(Dod.take({ directory: dir.path, id: "B-1", owner: alex }))
    await expireLeaseOf(dir.path, "B-1")
    expect(
      await fails(Dod.release({ directory: dir.path, id: "B-1", owner: cy, active: () => true })),
    ).toBe("B-1 is taken by Alex")
    const freed = await run(Dod.release({ directory: dir.path, id: "B-1", owner: cy, active: () => false }))
    expect(freed.items.find((entry) => entry.id === "B-1")?.owner).toBeUndefined()
  })
})

test("stale sweeper frees idle local claims without erasing checked work or active claims",async()=>{
 await using dir=await tmpdir()
 await mkdir(path.join(dir.path,".orchestra"),{recursive:true})
 await Bun.write(path.join(dir.path,".orchestra/dod.yaml"),`task_id: test
stages: []
leaves:
  - id: A
    what: Idle
    task_state: IN_PROGRESS
    owner: Worker
    owner_id: ses_idle
    lease_until: "2000-01-01T00:00:00.000Z"
    steps:
      - "[x] code"
      - "[ ] test"
  - id: B
    what: Active
    task_state: IN_PROGRESS
    owner: Worker
    owner_id: ses_active
    lease_until: "2000-01-01T00:00:00.000Z"
    steps:
      - "[ ] work"
`)
 expect(await Effect.runPromise(Dod.sweepStale({directory:dir.path,active:id=>id==="ses_active"}))).toEqual(["A"])
 const status=await Effect.runPromise(Dod.read(dir.path))
 expect(status.items.find(item=>item.id==="A")).toMatchObject({done:1,total:2,state:"IN_PROGRESS"})
 expect(status.items.find(item=>item.id==="A")?.owner).toBeUndefined()
 expect(status.items.find(item=>item.id==="B")?.owner).toBe("Worker")
 expect(await Effect.runPromise(Dod.sweepStale({directory:dir.path,active:()=>true}))).toEqual([])
})
