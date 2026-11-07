import { describe, expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import { Contracts } from "@orchestra/core/contracts"
import { Dod } from "@orchestra/core/dod"
import { Zones } from "@orchestra/core/zones"
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

  - id: B-3
    what: "Build three"
    group: "Build"
    task_state: NOT_STARTED
    steps:
      - "[ ] three"

  - id: B-4
    what: "Build four"
    group: "Build"
    task_state: NOT_STARTED
    steps:
      - "[ ] four"

  - id: D-1
    what: "Design one"
    group: "Design"
    task_state: NOT_STARTED
    steps:
      - "[ ] draw"
`

async function project(text = FILE) {
  const dir = await tmpdir()
  await mkdir(path.join(dir.path, ".orchestra"), { recursive: true })
  await Bun.write(path.join(dir.path, Dod.FILE), text)
  return dir
}

const alex = { id: "g-alex", name: "Alex" }
const bo = { id: "g-bo", name: "Bo" }
const cy = { id: "g-cy", name: "Cy" }
const dee = { id: "g-dee", name: "Dee" }

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)
const fails = <A>(effect: Effect.Effect<A, Dod.DodError>) =>
  Effect.runPromise(Effect.flip(effect)).then((error) => error.message)
const failsAny = <A, E extends { message: string }>(effect: Effect.Effect<A, E>) =>
  Effect.runPromise(Effect.flip(effect)).then((error) => error.message)

// Moves one item's lease into the past, as if its five minutes ran out.
async function expireLeaseOf(dirPath: string, id: string) {
  const file = path.join(dirPath, Dod.FILE)
  const text = await Bun.file(file).text()
  const at = text.indexOf(`id: ${id}`)
  const next = text.indexOf("- id:", at + 1)
  const block = text.slice(at, next < 0 ? undefined : next)
  const replaced = block.replace(/lease_until: "[^"]+"/, 'lease_until: "2000-01-01T00:00:00.000Z"')
  expect(replaced).not.toBe(block)
  await Bun.write(file, text.slice(0, at) + replaced + (next < 0 ? "" : text.slice(next)))
}

async function events(dirPath: string) {
  const file = path.join(dirPath, Dod.EVENTS_FILE)
  if (!(await Bun.file(file).exists())) return []
  return (await Bun.file(file).text())
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, string>)
}

describe("Dod guards: standby, WIP limit, zones, contracts", () => {
  test("add records a standby, and the standby takes over a stalled item", async () => {
    await using dir = await project()
    const added = await run(Dod.add({ directory: dir.path, what: "Guarded work", standby: bo }))
    await run(Dod.take({ directory: dir.path, id: added.id, owner: alex }))
    await expireLeaseOf(dir.path, added.id)
    const dod = await run(Dod.takeover({ directory: dir.path, id: added.id, owner: bo }))
    const item = dod.items.find((entry) => entry.id === added.id)!
    expect(item).toMatchObject({ owner: "Bo", ownerID: "g-bo", state: "IN_PROGRESS" })
    const text = await Bun.file(path.join(dir.path, Dod.FILE)).text()
    expect(text).toContain('took_over_by: "Bo"')
    expect(text).toMatch(/took_over_at: "[^"]+"/)
    expect(await events(dir.path)).toContainEqual(
      expect.objectContaining({ event: "standby.takeover", item: added.id, owner: "g-bo", from: "Alex" }),
    )
  })

  test("takeover refuses a non-standby and a lease that still runs", async () => {
    await using dir = await project()
    const added = await run(Dod.add({ directory: dir.path, what: "Guarded work", standby: bo }))
    await run(Dod.take({ directory: dir.path, id: added.id, owner: alex }))
    expect(await fails(Dod.takeover({ directory: dir.path, id: added.id, owner: bo }))).toContain(
      "is not stalled: its holder's lease still runs",
    )
    await expireLeaseOf(dir.path, added.id)
    expect(await fails(Dod.takeover({ directory: dir.path, id: added.id, owner: cy }))).toBe(
      `${added.id} standby is Bo; only the standby takes it over`,
    )
  })

  test("take by the standby on a stale item takes over in one step", async () => {
    await using dir = await project()
    const added = await run(Dod.add({ directory: dir.path, what: "Guarded work", standby: bo }))
    await run(Dod.take({ directory: dir.path, id: added.id, owner: alex }))
    await expireLeaseOf(dir.path, added.id)
    const dod = await run(Dod.take({ directory: dir.path, id: added.id, owner: bo }))
    expect(dod.items.find((entry) => entry.id === added.id)).toMatchObject({ owner: "Bo", state: "IN_PROGRESS" })
    expect(await events(dir.path)).toContainEqual(
      expect.objectContaining({ event: "standby.takeover", item: added.id }),
    )
  })

  test("a card marked for a human is refused on take, takeover and next", async () => {
    const human = `task_id: G-HUMAN
stages: []
leaves:
  - id: H-1
    what: "Human decision"
    group: "Build"
    task_state: IN_PROGRESS
    human: true
    owner: "Alex"
    owner_id: "g-alex"
    taken_at: "2000-01-01T00:00:00.000Z"
    lease_until: "2000-01-01T00:00:01.000Z"
    standby: "Bo"
    standby_id: "g-bo"
    steps:
      - "[ ] decide"
  - id: B-1
    what: "Build one"
    group: "Build"
    task_state: NOT_STARTED
    steps:
      - "[ ] one"
`
    await using dir = await project(human)
    expect(await fails(Dod.take({ directory: dir.path, id: "H-1", owner: bo }))).toContain("marked for a human")
    expect(await fails(Dod.takeover({ directory: dir.path, id: "H-1", owner: bo }))).toContain("marked for a human")
    const taken = await run(Dod.next({ directory: dir.path, owner: bo }))
    expect(taken.id).toBe("B-1")
  })

  test("the fourth concurrent claim in a group waits in queue, and the refusal is recorded", async () => {
    await using dir = await project()
    await run(Dod.take({ directory: dir.path, id: "B-1", owner: alex }))
    await run(Dod.take({ directory: dir.path, id: "B-2", owner: bo }))
    await run(Dod.take({ directory: dir.path, id: "B-3", owner: cy }))
    const refusal = await fails(Dod.take({ directory: dir.path, id: "B-4", owner: dee }))
    expect(refusal).toBe(
      `B-4 cannot start: group "Build" already has 3 tasks in work; it waits in queue until one finishes or is freed`,
    )
    expect(await events(dir.path)).toContainEqual(
      expect.objectContaining({ event: "wip.refusal", item: "B-4", group: "Build", owner: "g-dee" }),
    )
  })

  test("the WIP limit is per group and frees when one task is released", async () => {
    await using dir = await project()
    await run(Dod.take({ directory: dir.path, id: "B-1", owner: alex }))
    await run(Dod.take({ directory: dir.path, id: "B-2", owner: bo }))
    await run(Dod.take({ directory: dir.path, id: "B-3", owner: cy }))
    const other = await run(Dod.take({ directory: dir.path, id: "D-1", owner: dee }))
    expect(other.items.find((entry) => entry.id === "D-1")).toMatchObject({ owner: "Dee" })
    await run(Dod.release({ directory: dir.path, id: "B-1", owner: alex }))
    const freed = await run(Dod.take({ directory: dir.path, id: "B-4", owner: dee }))
    expect(freed.items.find((entry) => entry.id === "B-4")).toMatchObject({ owner: "Dee" })
  })

  test("re-taking one's own item is not blocked by the WIP limit", async () => {
    await using dir = await project()
    await run(Dod.take({ directory: dir.path, id: "B-1", owner: alex }))
    await run(Dod.take({ directory: dir.path, id: "B-2", owner: bo }))
    await run(Dod.take({ directory: dir.path, id: "B-3", owner: cy }))
    // `dod check` on a free item claims it without the take path, so a fourth
    // card can be in work; re-taking one's own item must still succeed — it is
    // not a new concurrent claim, even with three other cards in work.
    await run(Dod.check({ directory: dir.path, id: "B-4", step: 1, checked: true, owner: dee }))
    expect((await run(Dod.read(dir.path))).items.filter((item) => item.state === "IN_PROGRESS")).toHaveLength(4)
    const again = await run(Dod.take({ directory: dir.path, id: "B-1", owner: alex }))
    expect(again.items.find((entry) => entry.id === "B-1")).toMatchObject({ owner: "Alex" })
  })

  test("next skips an item the WIP limit blocks and takes a free one instead", async () => {
    await using dir = await project()
    await run(Dod.take({ directory: dir.path, id: "B-1", owner: alex }))
    await run(Dod.take({ directory: dir.path, id: "B-2", owner: bo }))
    await run(Dod.take({ directory: dir.path, id: "B-3", owner: cy }))
    const taken = await run(Dod.next({ directory: dir.path, owner: dee }))
    expect(taken.id).toBe("D-1")
  })

  test("a foreign group needs a pass; the zone owner takes freely", async () => {
    await using dir = await project()
    await run(Zones.register(dir.path, { name: "Build", ownerGroup: "builders" }))
    expect(
      await fails(Dod.take({ directory: dir.path, id: "B-1", owner: alex, group: "designers" })),
    ).toBe(`B-1 is in zone "Build" owned by "builders"; a pass from its owner is needed to take it. A stale claim grants the pass by itself.`)
    expect(await events(dir.path)).toContainEqual(
      expect.objectContaining({ event: "zone.refusal", item: "B-1", zone: "Build", group: "designers" }),
    )
    const owned = await run(Dod.take({ directory: dir.path, id: "B-1", owner: alex, group: "builders" }))
    expect(owned.items.find((entry) => entry.id === "B-1")).toMatchObject({ owner: "Alex" })
  })

  test("a granted pass opens the zone, and a stale claim is an automatic pass", async () => {
    await using dir = await project()
    await run(Zones.register(dir.path, { name: "Build", ownerGroup: "builders" }))
    await run(Zones.grantPass(dir.path, { zone: "Build", group: "designers", by: "Alex" }))
    const passed = await run(Dod.take({ directory: dir.path, id: "B-1", owner: bo, group: "designers" }))
    expect(passed.items.find((entry) => entry.id === "B-1")).toMatchObject({ owner: "Bo" })

    await using staleDir = await project()
    await run(Zones.register(staleDir.path, { name: "Build", ownerGroup: "builders" }))
    await run(Dod.take({ directory: staleDir.path, id: "B-1", owner: alex, group: "builders" }))
    await expireLeaseOf(staleDir.path, "B-1")
    const auto = await run(Dod.take({ directory: staleDir.path, id: "B-1", owner: bo, group: "designers" }))
    expect(auto.items.find((entry) => entry.id === "B-1")).toMatchObject({ owner: "Bo" })
    expect(await events(staleDir.path)).toContainEqual(
      expect.objectContaining({ event: "zone.auto-pass", item: "B-1", zone: "Build", group: "designers" }),
    )
  })

  test("without a zones registry there is no zone restriction", async () => {
    await using dir = await project()
    const dod = await run(Dod.take({ directory: dir.path, id: "B-1", owner: alex, group: "anyone" }))
    expect(dod.items.find((entry) => entry.id === "B-1")).toMatchObject({ owner: "Alex" })
  })

  test("the reserve group holds no planned tasks: it is named, not configured", () => {
    expect(Zones.isReserveGroup("reserve")).toBe(true)
    expect(Zones.isReserveGroup("builders")).toBe(false)
    expect(Zones.RESERVE_GROUP).toBe("reserve")
  })

  test("a draft contracts document blocks new work until accepted", async () => {
    await using dir = await project()
    expect(await run(Contracts.initialize(dir.path))).toBe("created")
    expect(await fails(Dod.take({ directory: dir.path, id: "B-1", owner: alex }))).toContain(
      "are not accepted yet: implementation work cannot start until they are accepted",
    )
    expect(await fails(Dod.next({ directory: dir.path, owner: alex }))).toContain("are not accepted yet")
    const accepted = await run(Contracts.accept(dir.path, "Alex"))
    expect(accepted.acceptedBy).toBe("Alex")
    const dod = await run(Dod.take({ directory: dir.path, id: "B-1", owner: alex }))
    expect(dod.items.find((entry) => entry.id === "B-1")).toMatchObject({ owner: "Alex" })
  })

  test("without a contracts document there is nothing to gate on", async () => {
    await using dir = await project()
    expect(await run(Contracts.status(dir.path))).toEqual({ exists: false })
    const dod = await run(Dod.take({ directory: dir.path, id: "B-1", owner: alex }))
    expect(dod.items.find((entry) => entry.id === "B-1")).toMatchObject({ owner: "Alex" })
  })

  test("accepting contracts without a document fails, and a change is recorded in the log", async () => {
    await using dir = await project()
    expect(await failsAny(Contracts.accept(dir.path, "Alex"))).toContain("has no contracts document")
    await run(Contracts.initialize(dir.path))
    const entry = await run(
      Contracts.recordChange(dir.path, {
        summary: "Session store moves behind a repository interface",
        reason: "two writers need one contract",
        decidedBy: "Alex",
        adr: "0005",
      }),
    )
    expect(entry).toContain("Session store moves behind a repository interface")
    expect(entry).toContain("ADR: 0005")
    const text = await Bun.file(path.join(dir.path, Contracts.FILE)).text()
    expect(text).toContain(entry)
    expect(text).not.toContain("<YYYY-MM-DD>")
  })

  test("zones register, pass and revoke round-trip; a stale claim needs no pass", async () => {
    await using dir = await project()
    const registry = await run(Zones.register(dir.path, { name: "Build", ownerGroup: "builders" }))
    expect(registry.zones).toEqual([{ name: "Build", owner_group: "builders" }])
    expect(Zones.claimRefusal(registry, { id: "B-1", stage: "Build" }, "designers")).toContain("a pass from its owner")
    expect(Zones.claimRefusal(registry, { id: "B-1", stage: "Build", stale: true }, "designers")).toBeUndefined()
    expect(Zones.claimRefusal(registry, { id: "B-1", stage: "Build" }, undefined)).toContain("no group was given")
    await run(Zones.grantPass(dir.path, { zone: "Build", group: "designers", by: "Alex" }))
    const withPass = await run(Zones.load(dir.path))
    expect(Zones.claimRefusal(withPass, { id: "B-1", stage: "Build" }, "designers")).toBeUndefined()
    await run(Zones.revokePass(dir.path, { zone: "Build", group: "designers" }))
    const revoked = await run(Zones.load(dir.path))
    expect(Zones.claimRefusal(revoked, { id: "B-1", stage: "Build" }, "designers")).toContain("a pass from its owner")
    expect(await failsAny(Zones.grantPass(dir.path, { zone: "Nope", group: "designers", by: "Alex" }))).toContain(
      'There is no zone "Nope"',
    )
  })

  test("take on a stale item with a standby refuses anyone but the standby", async () => {
    await using dir = await project()
    const added = await run(Dod.add({ directory: dir.path, what: "Guarded work", standby: bo }))
    await run(Dod.take({ directory: dir.path, id: added.id, owner: alex }))
    await expireLeaseOf(dir.path, added.id)
    // Before this fix any stranger took the stale item through `take`, while
    // `takeover` already required the standby.
    expect(await fails(Dod.take({ directory: dir.path, id: added.id, owner: cy }))).toBe(
      `${added.id} is stalled, but its standby is Bo; only the standby takes it over`,
    )
    const dod = await run(Dod.take({ directory: dir.path, id: added.id, owner: bo }))
    expect(dod.items.find((entry) => entry.id === added.id)).toMatchObject({ owner: "Bo", state: "IN_PROGRESS" })
    const text = await Bun.file(path.join(dir.path, Dod.FILE)).text()
    expect(text).toContain('took_over_by: "Bo"')
  })

  test("take on a stale item without a standby still passes to anyone", async () => {
    await using dir = await project()
    const added = await run(Dod.add({ directory: dir.path, what: "Unguarded work" }))
    await run(Dod.take({ directory: dir.path, id: added.id, owner: alex }))
    await expireLeaseOf(dir.path, added.id)
    // No reserve agent exists to protect, so refusing everyone would strand the
    // item forever — `takeover` needs a standby too.
    const dod = await run(Dod.take({ directory: dir.path, id: added.id, owner: cy }))
    expect(dod.items.find((entry) => entry.id === added.id)).toMatchObject({ owner: "Cy", state: "IN_PROGRESS" })
  })

  test("re-taking one's own stale item still works, standby or not", async () => {
    await using dir = await project()
    const added = await run(Dod.add({ directory: dir.path, what: "Guarded work", standby: bo }))
    await run(Dod.take({ directory: dir.path, id: added.id, owner: alex }))
    await expireLeaseOf(dir.path, added.id)
    const dod = await run(Dod.take({ directory: dir.path, id: added.id, owner: alex }))
    expect(dod.items.find((entry) => entry.id === added.id)).toMatchObject({ owner: "Alex", state: "IN_PROGRESS" })
  })

  test("next skips a stale item with a standby for anyone but the standby", async () => {
    const two = `task_id: G-1
stages: []
leaves:
  - id: S-1
    what: "Guarded work"
    group: "Build"
    task_state: NOT_STARTED
    steps:
      - "[ ] one"

  - id: F-1
    what: "Free work"
    group: "Build"
    task_state: NOT_STARTED
    steps:
      - "[ ] one"
`
    await using dir = await project(two)
    await run(Dod.take({ directory: dir.path, id: "S-1", owner: alex }))
    // The standby is recorded by hand here: `dod add` writes it, a board edited by
    // hand carries the same fields.
    const board = await Bun.file(path.join(dir.path, Dod.FILE)).text()
    await Bun.write(
      path.join(dir.path, Dod.FILE),
      board.replace('  - id: S-1\n', '  - id: S-1\n    standby: "Bo"\n    standby_id: "g-bo"\n'),
    )
    await expireLeaseOf(dir.path, "S-1")
    const skipped = await run(Dod.next({ directory: dir.path, owner: cy }))
    expect(skipped.id).toBe("F-1")
    const taken = await run(Dod.next({ directory: dir.path, owner: bo }))
    expect(taken.id).toBe("S-1")
  })

  test("check and block on a stale item with a standby refuse anyone but the standby", async () => {
    await using dir = await project()
    const added = await run(Dod.add({ directory: dir.path, what: "Guarded work", standby: bo, steps: ["one"] }))
    await run(Dod.take({ directory: dir.path, id: added.id, owner: alex }))
    await expireLeaseOf(dir.path, added.id)
    // `check` and `block` used to claim a stale item for whoever called first.
    expect(
      await fails(Dod.check({ directory: dir.path, id: added.id, step: 1, checked: true, owner: cy })),
    ).toBe(`${added.id} is stalled, but its standby is Bo; only the standby takes it over`)
    expect(await fails(Dod.block({ directory: dir.path, id: added.id, owner: cy, reason: "stuck" }))).toBe(
      `${added.id} is stalled, but its standby is Bo; only the standby takes it over`,
    )
    const checked = await run(Dod.check({ directory: dir.path, id: added.id, step: 1, checked: true, owner: bo }))
    expect(checked.items.find((entry) => entry.id === added.id)).toMatchObject({
      owner: "Bo",
      state: "IN_PROGRESS",
    })
    const text = await Bun.file(path.join(dir.path, Dod.FILE)).text()
    expect(text).toContain('took_over_by: "Bo"')
  })

  test("check and block on a stale item without a standby still pass to anyone", async () => {
    await using dir = await project()
    await run(Dod.take({ directory: dir.path, id: "B-1", owner: alex }))
    await expireLeaseOf(dir.path, "B-1")
    const blocked = await run(Dod.block({ directory: dir.path, id: "B-1", owner: cy, reason: "stuck" }))
    expect(blocked.items.find((entry) => entry.id === "B-1")).toMatchObject({ owner: "Cy", state: "BLOCKED" })
  })
})
