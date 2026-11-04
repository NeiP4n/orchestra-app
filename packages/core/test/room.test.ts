import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { Room } from "@orchestra/core/room"
import { SessionID } from "@orchestra/schema/session-id"
import { LayerNode } from "@orchestra/util/effect/layer-node"
import { testEffect } from "./lib/effect"

const it = testEffect(LayerNode.compile(Room.node))

describe("Room", () => {
  // Regression: KV.scan returns at most 1000 entries per page and bans are
  // not bounded by the live member cap, so a room that accumulates more than
  // 1000 bans used to lose the rest — they were neither listed nor matched
  // by the join check, and removing the room left them behind in KV.
  it.effect(
    "bans past the first KV page are listed, recognised, and removed with the room",
    () =>
      Effect.gen(function* () {
        const rooms = yield* Room.Service
        const room = yield* rooms.create({ sessionID: SessionID.create() })

        // Fillers sort before the victim in key order, so the victim's ban is
        // the first entry of the second page.
        yield* Effect.forEach(
          Array.from({ length: 1000 }, (_, index) => index),
          (index) =>
            rooms.ban(room.id, {
              id: `ban-${String(index).padStart(4, "0")}`,
              name: `guest-${index}`,
              device: `device-${index}`,
              created: index,
            }),
          { discard: true },
        )
        yield* rooms.ban(room.id, { id: "zz-victim", name: "victim", device: "victim-device", created: 1000 })

        const bans = yield* rooms.bans(room.id)
        expect(bans).toHaveLength(1001)
        expect(Room.banned(bans, { device: "victim-device" })).toBe(true)
        expect(Room.banned(bans, { device: "never-banned" })).toBe(false)

        yield* rooms.remove(room.id)
        // bans() reads the room's raw KV prefix, so an empty result here
        // proves no ban record survived the removal past the first page.
        expect(yield* rooms.bans(room.id)).toHaveLength(0)
      }),
    120_000,
  )
})
