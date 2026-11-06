export * as Recovery from "./service.js"

import { LLMClient } from "@orchestra/ai"
import type { Model as ModelSchema } from "@orchestra/schema/model"
import type { Recovery as RecoverySchema } from "@orchestra/schema/recovery"
import { makeLocationNode } from "@orchestra/util/effect/app-node"
import { Cause, Context, Effect, Layer } from "effect"
import { llmClient } from "../effect/app-node-platform.js"
import { Model } from "../model.js"
import { ModelResolver } from "../model-resolver.js"
import { runRepairLoop } from "./agent.js"
import { listRecoveryModels } from "./models.js"

export interface Interface {
  /** Models the recovery mini-chat offers (working providers only — never dead ones). */
  readonly listModels: () => Effect.Effect<readonly RecoverySchema.RecoveryModel[]>
  /**
   * One repair round with the chosen model. A model or provider failure is
   * returned as a reply, not thrown: the user is already looking at a broken
   * Orchestra, and a bare 500 with no words helps no one.
   */
  readonly chat: (input: {
    model: ModelSchema.Ref
    messages: readonly RecoverySchema.RecoveryChatMessage[]
  }) => Effect.Effect<RecoverySchema.RecoveryResult>
}

export class Service extends Context.Service<Service, Interface>()("@orchestra/Recovery") {}

const causeMessage = (cause: Cause.Cause<unknown>): string => {
  const failure = Cause.findErrorOption(cause)
  if (failure._tag === "Some") {
    const error = failure.value
    if (error instanceof Error && error.message.trim()) return error.message.trim()
    return String(error)
  }
  return "неизвестная ошибка"
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const models = yield* Model.Service
    const resolver = yield* ModelResolver.Service
    const llm = yield* LLMClient.Service
    const chat = Effect.fn("Recovery.chat")(function* (input: {
      model: ModelSchema.Ref
      messages: readonly RecoverySchema.RecoveryChatMessage[]
    }) {
      const attempt = Effect.gen(function* () {
        const info = yield* models.get(input.model.providerID, input.model.id)
        if (!info) return yield* Effect.fail(new Error(`Модель не найдена: ${input.model.providerID}/${input.model.id}`))
        const resolved = yield* resolver.resolveModel(info)
        return yield* runRepairLoop({
          model: resolved.model,
          ref: input.model,
          messages: input.messages,
          root: process.cwd(),
        }).pipe(Effect.provideService(LLMClient.Service, llm))
      })
      return yield* attempt.pipe(
        Effect.catchCause((cause) =>
          Effect.succeed<RecoverySchema.RecoveryResult>({
            reply: `Не удалось вызвать модель ${input.model.providerID}/${input.model.id}: ${causeMessage(cause)}. Проверьте ключи провайдера и попробуйте другую модель.`,
            steps: [],
            model: input.model,
          }),
        ),
      )
    })
    return Service.of({
      listModels: Effect.fn(function* () {
        return listRecoveryModels(yield* models.available())
      }),
      chat,
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Model.node, ModelResolver.node, llmClient],
})
