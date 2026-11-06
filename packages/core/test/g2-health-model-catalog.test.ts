import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Integration } from "@orchestra/core/integration"
import { Credential } from "@orchestra/core/credential"
import { AppNodeBuilder } from "@orchestra/core/effect/app-node-builder"
import { LayerNode } from "@orchestra/util/effect/layer-node"
import { Bus } from "@orchestra/core/bus"
import { Location } from "@orchestra/core/location"
import { Model } from "@orchestra/core/model"
import { Provider } from "@orchestra/core/provider"
import { AbsolutePath } from "@orchestra/core/schema"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"

const locationLayer = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory: AbsolutePath.make("test") })),
)
const modelLayer = AppNodeBuilder.build(
  LayerNode.group([Provider.node, Model.node, Bus.node, Credential.node, Integration.node]),
  [Location.node.replace(locationLayer)],
)
const it = testEffect(modelLayer)

const MODEL_IDS = [
  "sonnet-5",
  "opus-5.5",
  "sonnet-5.5",
  "anymodel-coder",
  "gpt-6-sol",
  "gpt-6-astra",
  "gpt-6.1-sol",
  "gpt-6-luna",
  "opus-5",
  "fable-5.1",
  "anymodel-reasoner",
  "anymodel-v4.1-flash",
]

// A config-defined provider the way B14 had it: baseURL + models, no key
// anywhere. The config plugin must NOT stamp such a provider "enabled"
// (G2-6), so here it stays "auto": availability is decided by the
// credential/env connection, of which there is none.
const registerKeylessAnymodel = Effect.fn(function* () {
  const providers = yield* Provider.Service
  const integrations = yield* Integration.Service
  const providerID = Provider.ID.make("anymodel")
  const integrationID = Integration.ID.make("anymodel")
  yield* integrations.transform((editor) => {
    editor.method.update({ integrationID, method: { type: "key", label: "Manually enter API Key" } })
  })
  yield* providers.transform((editor) => {
    editor.update(providerID, (provider) => {
      provider.integrationID = integrationID
      provider.package = "@orchestra/ai/providers/openai-compatible"
      provider.settings = { baseURL: "https://anymodel.ghostly.su/v1" }
    })
    for (const id of MODEL_IDS) editor.models.update(providerID, Model.ID.make(id), () => {})
  })
  return { providerID, integrationID }
})

it.effect("G2-6: a keyless provider is not available, its models are not listed, and it is never the default", () =>
  Effect.gen(function* () {
    const providers = yield* Provider.Service
    const models = yield* Model.Service
    yield* registerKeylessAnymodel()
    expect(yield* providers.available()).toEqual([])
    expect(yield* models.available()).toEqual([])
    expect(yield* models.default()).toBeUndefined()
  }),
)

it.effect("G2-6: a configured default on a keyless provider is ignored instead of becoming the session default", () =>
  Effect.gen(function* () {
    const models = yield* Model.Service
    const { providerID } = yield* registerKeylessAnymodel()
    yield* models.transform((editor) => editor.default.set(providerID, Model.ID.make("sonnet-5")))
    expect(yield* models.default()).toBeUndefined()
  }),
)

it.effect("G2-6: the same provider becomes available — and a usable default — once its credential arrives", () =>
  Effect.gen(function* () {
    const providers = yield* Provider.Service
    const models = yield* Model.Service
    const credentials = yield* Credential.Service
    const { providerID, integrationID } = yield* registerKeylessAnymodel()
    expect(yield* models.default()).toBeUndefined()
    yield* credentials.create({
      integrationID,
      value: Credential.Key.make({ type: "key", key: "test-key" }),
    })
    expect((yield* providers.available()).map((provider) => provider.id)).toEqual([providerID])
    expect((yield* models.available()).map((model) => model.id).toSorted()).toEqual(
      MODEL_IDS.map((id) => Model.ID.make(id)).toSorted(),
    )
    const def = yield* models.default()
    expect(def?.providerID).toBe(providerID)
  }),
)
