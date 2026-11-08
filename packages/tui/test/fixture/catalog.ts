import type { ModelInfo, ProviderInfo } from "@orchestra/client"

// A local, enabled, zero-price model. No credential or provider-routing policy is implied.
export function freeModel(id: string, providerID: string, name = id): ModelInfo {
  return {
    id, modelID: id, providerID, name,
    status: "active", enabled: true,
    capabilities: { input: ["text"], output: ["text"], tools: true },
    cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
    limit: { context: 10000, output: 1000 },
    time: { released: 0 }, variants: [],
  }
}

export function provider(id: string, name = id): ProviderInfo {
  return { id, name, activation: "auto", package: "" }
}
