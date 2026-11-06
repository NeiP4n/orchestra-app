import { describe, expect, test } from "bun:test"
import { statSync } from "node:fs"
import path from "node:path"
import { Effect } from "effect"
import { Zones } from "@orchestra/core/zones"
import { tmpdir } from "./fixture/tmpdir"
// The Flock lock in Zones needs the Flock global (state directory), set as a
// side effect of importing Global.
import "@orchestra/util/global"

const run = <A>(effect: Effect.Effect<A, Zones.ZonesError>) =>
  Effect.runPromise(effect.pipe(Effect.scoped))

describe("zones registry", () => {
  test("registers, passes and revokes", async () => {
    await using tmp = await tmpdir()
    const dir = tmp.path
    await run(Zones.register(dir, { name: "auth", ownerGroup: "team-a" }))
    const pass = await run(Zones.grantPass(dir, { zone: "auth", group: "team-b", by: "owner" }))
    expect(pass.group).toBe("team-b")
    const registry = await run(Zones.load(dir))
    expect(registry.zones).toHaveLength(1)
    expect(registry.passes).toHaveLength(1)
    expect(Zones.claimRefusal(registry, { id: "x", stage: "auth" }, "team-b")).toBeUndefined()
    await run(Zones.revokePass(dir, { zone: "auth", group: "team-b" }))
    expect((await run(Zones.load(dir))).passes).toHaveLength(0)
    await run(Zones.unregister(dir, "auth"))
    expect((await run(Zones.load(dir))).zones).toHaveLength(0)
  })

  // A3-08: two agents registering zones at once used to read the same
  // registry and lose one of the writes (load→save with no lock).
  test("concurrent registers never lose a zone", async () => {
    await using tmp = await tmpdir()
    const dir = tmp.path
    await Effect.runPromise(
      Effect.all(
        Array.from({ length: 10 }, (_, index) =>
          Zones.register(dir, { name: `zone-${index}`, ownerGroup: `team-${index}` }),
        ),
        { concurrency: "unbounded" },
      ).pipe(Effect.scoped),
    )
    const registry = await run(Zones.load(dir))
    expect(registry.zones.map((zone) => zone.name).sort()).toEqual(
      Array.from({ length: 10 }, (_, index) => `zone-${index}`).sort(),
    )
  })

  // A3-08: same race for passes into one zone.
  test("concurrent pass grants never lose a pass", async () => {
    await using tmp = await tmpdir()
    const dir = tmp.path
    await run(Zones.register(dir, { name: "auth", ownerGroup: "team-a" }))
    await Effect.runPromise(
      Effect.all(
        Array.from({ length: 10 }, (_, index) =>
          Zones.grantPass(dir, { zone: "auth", group: `team-${index}`, by: "owner" }),
        ),
        { concurrency: "unbounded" },
      ).pipe(Effect.scoped),
    )
    const registry = await run(Zones.load(dir))
    expect(registry.passes.map((pass) => pass.group).sort()).toEqual(
      Array.from({ length: 10 }, (_, index) => `team-${index}`).sort(),
    )
  })

  // A3-13: zones.yaml holds group names and owner ids next to the database
  // and the key file, so it gets their 0600, not 0644.
  test("saves zones.yaml with owner-only permissions", async () => {
    await using tmp = await tmpdir()
    const dir = tmp.path
    await run(Zones.register(dir, { name: "auth", ownerGroup: "team-a" }))
    const file = path.join(dir, ".orchestra", "zones.yaml")
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })
})
