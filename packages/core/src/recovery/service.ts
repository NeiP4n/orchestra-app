export * as Recovery from "./service.js"

import { existsSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
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

/**
 * The Orchestra checkout the repair agent may touch. Never the server's
 * working directory: `serve` runs from the user's project, and repairing
 * that project (and reading its `.env`) instead of Orchestra itself is
 * exactly the confusion the old `process.cwd()` root caused. The root is
 * the ancestor that holds `packages/core` — this file lives under it — with
 * an `ORCHESTRA_REPO_ROOT` override for installs whose layout differs, and
 * the working directory only as a last resort. The resolved root is
 * returned in every `RecoveryResult` (and logged), so it is always visible
 * what was actually repaired.
 */
export function resolveRepoRoot(startDir = path.dirname(fileURLToPath(import.meta.url))): string {
  const override = process.env.ORCHESTRA_REPO_ROOT?.trim()
  if (override) return override
  let dir = startDir
  while (true) {
    if (existsSync(path.join(dir, "packages", "core", "package.json"))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) return process.cwd()
    dir = parent
  }
}

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
        const root = resolveRepoRoot()
        yield* Effect.logInfo("recovery: repair round in repo", { root })
        return yield* runRepairLoop({
          model: resolved.model,
          ref: input.model,
          messages: input.messages,
          root,
        }).pipe(Effect.provideService(LLMClient.Service, llm))
      })
      return yield* attempt.pipe(
        Effect.catchCause((cause) =>
          Effect.succeed<RecoverySchema.RecoveryResult>({
            reply: `Не удалось вызвать модель ${input.model.providerID}/${input.model.id}: ${causeMessage(cause)}. Проверьте ключи провайдера и попробуйте другую модель.`,
            steps: [],
            root: resolveRepoRoot(),
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
