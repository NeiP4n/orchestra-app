import type { ModelInfo, ModelRef } from "@orchestra/client"

export function modelKey(model: { readonly providerID: string; readonly id: string }) {
  return `${model.providerID}/${model.id}`
}

/**
 * Zen's free tier caps each address per model: one chat can be refused on its model while another
 * keeps working on a different free model from the same address. When the address cannot be
 * changed, a chat stopped by the cap moves to another free model of the same provider that has not
 * been refused from this address yet. Tools are required because agents cannot work without them;
 * the newest release is preferred.
 */
export function pickFallbackModel(models: readonly ModelInfo[], current: ModelRef, capped: ReadonlySet<string>) {
  return models
    .filter(
      (model) =>
        model.providerID === current.providerID &&
        model.modelID !== current.id &&
        model.enabled &&
        model.status !== "deprecated" &&
        model.capabilities.tools &&
        model.cost.length > 0 &&
        model.cost.every((cost) => cost.input === 0) &&
        !capped.has(modelKey({ providerID: model.providerID, id: model.modelID })),
    )
    .toSorted((left, right) => right.time.released - left.time.released)
    .at(0)
}
