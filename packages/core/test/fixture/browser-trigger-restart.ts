import { Effect } from "effect"
import { AppNodeBuilder } from "@orchestra/core/effect/app-node-builder"
import { Database } from "@orchestra/core/database/database"
import { KV } from "@orchestra/core/kv"
import { Trigger } from "@orchestra/core/trigger"
import { TriggerDelivery as Delivery } from "@orchestra/core/trigger-delivery"
const mode = process.argv[2]
const now = Date.parse("2026-11-10T00:00:00Z")
const key = Trigger.key("p_restart", "trg_browser_restart")
const event = { sessionID: "browser_restart", at: now, items: [{ chat: "fixture", text: "private fixture row" }] }
const check = (value: unknown) => {
  if (!value) throw Error(`restart invariant failed (${mode})`)
}
await Effect.runPromise(
  Effect.gen(function* () {
    const kv = yield* KV.Service
    if (mode === "queue") {
      const made = Trigger.create(
        { kind: "browser", spec: event.sessionID, prompt: "fixed reviewed instruction" },
        { id: "trg_browser_restart", projectID: "p_restart", now, existing: 0 },
      )
      if (!made.ok) throw Error(made.error)
      yield* kv.set(key, Delivery.enqueueBrowser(made.trigger, event) as never)
    } else {
      const current = Trigger.parse(yield* kv.get(key))!
      check(current)
      if (mode === "reserve") {
        check(current.browserQueue?.rows[0]?.text === "private fixture row")
        const replayed = Trigger.parse(Delivery.enqueueBrowser(current, event))!
        check(replayed.browserQueue?.rows.length === 1)
        yield* kv.atomicUpdate(key, (value) => Delivery.reserveBrowser(value, now, "ses_main") as never)
      } else {
        check(current.pendingFire?.rows?.[0]?.text === "private fixture row")
        check(current.pendingFire?.messageID === Delivery.messageID(Delivery.fireID(current.id, now)))
        check(current.total === 1)
        check(JSON.stringify(Delivery.reserveBrowser(current, now + 60_000, "ses_main")) === JSON.stringify(current))
        yield* kv.atomicUpdate(key, (value) => Delivery.acknowledge(value, current.pendingFire!.fireId) as never)
        const after = Trigger.parse(yield* kv.get(key))!
        check(after.total === 1 && !after.pendingFire && after.browserQueue?.rows.length === 0)
      }
    }
    console.log(`browser-restart-${mode}-ok`)
    // Deliberately skip graceful scoped finalization, like the service dying after a committed KV write.
    process.exit(0)
  }).pipe(
    Effect.provide(
      AppNodeBuilder.build(KV.node, [Database.node.replace(Database.configured({ path: process.env.ORCHESTRA_DB! }))]),
    ),
  ),
)
