import { describe, expect, test } from "bun:test"
import path from "node:path"
import { Effect, Layer, Stream } from "effect"
import { Bus } from "@orchestra/core/bus"
import { Database } from "@orchestra/core/database/database"
import { AppNodeBuilder } from "@orchestra/core/effect/app-node-builder"
import { EventTable } from "@orchestra/core/event/sql"
import { Event } from "@orchestra/schema/event"
import { Session } from "@orchestra/schema/session"
import { SessionEvent } from "@orchestra/schema/session-event"
import { LayerNode } from "@orchestra/util/effect/layer-node"
import { Global } from "@orchestra/util/global"
import { eq } from "drizzle-orm"
import { tmpdir } from "./fixture/tmpdir"

// G2-7: durable events persist by default. A bare `Bus.configured()` — the
// shape `orchestra serve` builds — used to drop every payload on restart
// (`persist ?? false`), so the durable history was gone after re-entering.
// These tests use a file database and rebuild the whole layer between
// phases, the way a server restart does. The event is a registered durable
// session event so `log` can decode it back.
const Renamed = SessionEvent.Renamed

const layerFor = (file: string, data: string) =>
  AppNodeBuilder.build(LayerNode.group([Database.node, Bus.node]), [
    // A node replacement must be a closed layer: close the Database layer
    // over the test's Global instead of leaving Global as a requirement.
    Database.node.replace(
      Layer.provide(Database.layer({ path: file }), Layer.succeed(Global.Service, Global.make({ data }))),
    ),
  ])

// `Database.layer` needs `Global.Service`; the test provides it around the
// program, the way `database-backup.test.ts` does.
const runWith = <A, E>(file: string, data: string, program: Effect.Effect<A, E, Database.Service | Bus.Service>) =>
  Effect.runPromise(
    program.pipe(
      Effect.provide(layerFor(file, data)),
      Effect.provideService(Global.Service, Global.make({ data })),
      Effect.scoped,
    ),
  )

describe("Bus durable events persist by default", () => {
  test("a durable event survives a restart with no persist option", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "orchestra-local.db")
    const aggregateID = Session.ID.create()

    // Phase 1: publish with the default Bus — no `persist` option anywhere.
    await runWith(
      file,
      tmp.path,
      Effect.gen(function* () {
        const bus = yield* Bus.Service
        const { db } = yield* Database.Service
        const event = yield* bus.publish(Renamed, { sessionID: aggregateID, title: "hello" })
        expect(event.durable?.seq).toBe(Event.Seq.make(0))
        expect(
          yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, aggregateID)).all(),
        ).toHaveLength(1)
      }),
    )

    // Phase 2: rebuild the layer over the same file, as a restart does.
    // The payload must still be there — in the table and through `log`.
    await runWith(
      file,
      tmp.path,
      Effect.gen(function* () {
        const bus = yield* Bus.Service
        const { db } = yield* Database.Service
        const rows = yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, aggregateID)).all()
        expect(rows).toHaveLength(1)
        expect(rows[0]?.type).toBe("session.renamed.1")
        const items = yield* bus
          .log({ aggregateID })
          .pipe(Stream.filter((item): item is Event.Payload => !Bus.isSynced(item)), Stream.runCollect)
        expect(items).toHaveLength(1)
        expect(items[0]?.type).toBe(Renamed.type)
        expect(items[0]?.data).toEqual({ sessionID: aggregateID, title: "hello" })
      }),
    )
  })
})
