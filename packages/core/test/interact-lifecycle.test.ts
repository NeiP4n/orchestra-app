import { describe, expect } from "bun:test"
import { Deferred, Effect, Fiber } from "effect"
import { AppNodeBuilder } from "@orchestra/core/effect/app-node-builder"
import { LayerNode } from "@orchestra/util/effect/layer-node"
import { Bus } from "@orchestra/core/bus"
import { Form } from "@orchestra/core/form"
import { Interactive } from "@orchestra/schema/interactive"
import { responseOf, toFields } from "../src/tool/plugin/interact"
import { testEffect } from "./lib/effect"

const forms = AppNodeBuilder.build(LayerNode.group([Bus.node, Form.node]))
const it = testEffect(forms)

const decision: Interactive.Decision = {
  type: "decision",
  title: "Choose an architecture",
  options: [
    { id: "mono", label: "Monolith", recommended: true },
    { id: "micro", label: "Microservices" },
  ],
}

const ask = (service: Form.Interface, sessionID: string) =>
  service.ask({
    sessionID,
    title: decision.title,
    metadata: { kind: "interactive", block: decision },
    fields: toFields(decision),
  })

describe("interactive blocks on the form engine — lifecycle", () => {
  it.effect("ask blocks until the person replies, and the reply maps back to the structured response", () =>
    Effect.gen(function* () {
      const service = yield* Form.Service
      const bus = yield* Bus.Service
      const created = yield* Deferred.make<Form.Info>()
      const unsubscribe = yield* bus.listen((event) =>
        event.type === Form.Event.Created.type
          ? Deferred.succeed(created, (event.data as { readonly form: Form.Info }).form).pipe(Effect.asVoid)
          : Effect.void,
      )
      yield* Effect.addFinalizer(() => unsubscribe)
      const fiber = yield* ask(service, "ses_a").pipe(Effect.forkScoped)
      const form = yield* Deferred.await(created)
      // the block rides the form's metadata: renderers key off it, the form's
      // own fields stay the validated answer channel
      expect(form.metadata?.kind).toBe("interactive")
      expect((form.metadata?.block as Interactive.Decision).options).toHaveLength(2)
      expect(yield* service.state(form.id)).toEqual({ status: "pending" })

      yield* service.reply({ id: form.id, answer: { choice: "micro", comment: "We expect growth" } })
      const state = yield* Fiber.join(fiber)
      expect(state.status).toBe("answered")
      if (state.status === "answered") {
        expect(responseOf(decision, state.answer)).toEqual({ selected: ["micro"], comment: "We expect growth" })
      }
      // the settled state stays readable (transcript/history) after completion
      expect(yield* service.state(form.id)).toEqual({
        status: "answered",
        answer: { choice: "micro", comment: "We expect growth" },
      })
    }),
  )

  it.effect("a settled block cannot be answered twice, and a forged id is not found", () =>
    Effect.gen(function* () {
      const service = yield* Form.Service
      const form = yield* service.create({
        sessionID: "ses_a",
        title: decision.title,
        metadata: { kind: "interactive", block: decision },
        fields: toFields(decision),
      })
      yield* service.reply({ id: form.id, answer: { choice: "mono" } })
      const again = yield* service.reply({ id: form.id, answer: { choice: "micro" } }).pipe(Effect.flip)
      expect(again._tag).toBe("Form.AlreadySettledError")
      const forged = yield* service.reply({ id: Form.ID.create("frm_forged"), answer: { choice: "mono" } }).pipe(Effect.flip)
      expect(forged._tag).toBe("Form.NotFoundError")
    }),
  )

  it.effect("pending blocks are scoped to their session and cancellation settles the ask", () =>
    Effect.gen(function* () {
      const service = yield* Form.Service
      const bus = yield* Bus.Service
      const created = yield* Deferred.make<Form.Info>()
      const unsubscribe = yield* bus.listen((event) =>
        event.type === Form.Event.Created.type
          ? Deferred.succeed(created, (event.data as { readonly form: Form.Info }).form).pipe(Effect.asVoid)
          : Effect.void,
      )
      yield* Effect.addFinalizer(() => unsubscribe)
      const fiber = yield* ask(service, "ses_owner").pipe(Effect.forkScoped)
      yield* Deferred.await(created)
      const mine = yield* service.list({ sessionID: "ses_owner" })
      expect(mine).toHaveLength(1)
      // another session sees none of this session's pending blocks
      expect(yield* service.list({ sessionID: "ses_other" })).toHaveLength(0)
      yield* service.cancel(mine[0].id)
      expect(yield* Fiber.join(fiber)).toEqual({ status: "cancelled" })
    }),
  )

  it.effect("a custom answer is preserved as the user's own words, not forced into a listed id", () =>
    Effect.gen(function* () {
      const service = yield* Form.Service
      const form = yield* service.create({
        sessionID: "ses_a",
        title: decision.title,
        metadata: { kind: "interactive", block: decision },
        fields: toFields(decision),
      })
      yield* service.reply({ id: form.id, answer: { choice: "A hybrid, decided per service" } })
      const state = yield* service.state(form.id)
      expect(state.status).toBe("answered")
      if (state.status === "answered") {
        expect(responseOf(decision, state.answer)).toEqual({ comment: "A hybrid, decided per service" })
      }
    }),
  )
})
