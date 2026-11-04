import type { ConfigModel } from "@orchestra/schema/config/model"
import type { ConfigProvider } from "@orchestra/schema/config/provider"

/**
 * Model collections and custom endpoints — the pure management logic.
 *
 * Collections are plain config data (see Config.ModelCollection): named
 * sets of "provider/model" refs. Everything here is a pure function over
 * that data so the TUI, tests and any future client share one behavior:
 * refs are deduplicated, ids are unique slugs, and resolving a collection
 * against the live registry reports missing refs instead of dropping
 * them silently.
 */

export type Collection = ConfigModel.Collection

const REF = /^[^/#]+\/[^#]+$/

export const isModelRef = (value: string): boolean => REF.test(value)

export const modelRef = (providerID: string, modelID: string): string => `${providerID}/${modelID}`

export function parseModelRef(ref: string): { providerID: string; modelID: string } | undefined {
  const slash = ref.indexOf("/")
  if (slash <= 0 || slash === ref.length - 1) return undefined
  return { providerID: ref.slice(0, slash), modelID: ref.slice(slash + 1) }
}

/** URL/name-safe slug, made unique against the taken set with -2, -3, … */
export function slugify(name: string, taken: ReadonlySet<string>): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "collection"
  if (!taken.has(base)) return base
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`
    if (!taken.has(candidate)) return candidate
  }
}

/** Repairs untrusted collection data: unique ids, trimmed names, valid deduplicated refs. */
export function normalizeCollections(input: readonly Collection[]): Collection[] {
  const ids = new Set<string>()
  const result: Collection[] = []
  for (const item of input) {
    if (!item || typeof item.name !== "string" || !item.name.trim()) continue
    const id = item.id && !ids.has(item.id) ? item.id : slugify(item.name, ids)
    ids.add(id)
    const models: string[] = []
    const seen = new Set<string>()
    for (const ref of item.models ?? []) {
      if (typeof ref !== "string" || !isModelRef(ref) || seen.has(ref)) continue
      seen.add(ref)
      models.push(ref)
    }
    result.push({ id, name: item.name.trim(), enabled: item.enabled !== false, models })
  }
  return result
}

export function createCollection(collections: readonly Collection[], name: string): Collection[] {
  const id = slugify(name, new Set(collections.map((item) => item.id)))
  return [...collections, { id, name: name.trim(), enabled: true, models: [] }]
}

export function renameCollection(collections: readonly Collection[], id: string, name: string): Collection[] {
  return collections.map((item) => (item.id === id ? { ...item, name: name.trim() || item.name } : item))
}

export function removeCollection(collections: readonly Collection[], id: string): Collection[] {
  return collections.filter((item) => item.id !== id)
}

export function setCollectionEnabled(collections: readonly Collection[], id: string, enabled: boolean): Collection[] {
  return collections.map((item) => (item.id === id ? { ...item, enabled } : item))
}

/** Adds refs to a collection, skipping invalid refs and duplicates. Returns the new list and what was added. */
export function addModels(
  collections: readonly Collection[],
  id: string,
  refs: readonly string[],
): { collections: Collection[]; added: string[] } {
  const added: string[] = []
  const next = collections.map((item) => {
    if (item.id !== id) return item
    const seen = new Set(item.models)
    const models = [...item.models]
    for (const ref of refs) {
      if (!isModelRef(ref) || seen.has(ref)) continue
      seen.add(ref)
      models.push(ref)
      added.push(ref)
    }
    return { ...item, models }
  })
  return { collections: next, added }
}

export function removeModel(collections: readonly Collection[], id: string, ref: string): Collection[] {
  return collections.map((item) =>
    item.id === id ? { ...item, models: item.models.filter((model) => model !== ref) } : item,
  )
}

export interface ResolvedCollection {
  readonly collection: Collection
  /** Refs whose provider and model are both currently available. */
  readonly resolved: readonly string[]
  /** Refs kept in the collection whose provider/model is not currently available. */
  readonly missing: readonly string[]
}

/** Resolves collections against the live registry snapshot (providerID → its model ids). */
export function resolveCollections(
  collections: readonly Collection[],
  available: ReadonlyMap<string, ReadonlySet<string>>,
): ResolvedCollection[] {
  return collections.map((collection) => {
    const resolved: string[] = []
    const missing: string[] = []
    for (const ref of collection.models) {
      const parsed = parseModelRef(ref)
      if (parsed && available.get(parsed.providerID)?.has(parsed.modelID)) resolved.push(ref)
      else missing.push(ref)
    }
    return { collection, resolved, missing }
  })
}

/** The refs a picker should offer: enabled collections only, resolved, in collection order. */
export function pickerRefs(
  collections: readonly Collection[],
  available: ReadonlyMap<string, ReadonlySet<string>>,
): { collection: Collection; refs: readonly string[] }[] {
  return resolveCollections(collections, available)
    .filter((entry) => entry.collection.enabled && entry.resolved.length > 0)
    .map((entry) => ({ collection: entry.collection, refs: entry.resolved }))
}

/* ------------------------------------------------------------------ */
/* Custom endpoints                                                    */
/* ------------------------------------------------------------------ */

/** API protocol / compatibility modes an endpoint can declare, mapped to provider packages. */
export const ENDPOINT_PROTOCOLS = [
  { id: "openai-compatible", label: "OpenAI-compatible", package: "@orchestra/ai/providers/openai-compatible" },
  { id: "openai", label: "OpenAI", package: "@orchestra/ai/providers/openai" },
  { id: "anthropic", label: "Anthropic", package: "@orchestra/ai/providers/anthropic" },
  { id: "openrouter", label: "OpenRouter", package: "@orchestra/ai/providers/openrouter" },
] as const

export type EndpointProtocol = (typeof ENDPOINT_PROTOCOLS)[number]["id"]

export const protocolPackage = (protocol: string): string =>
  ENDPOINT_PROTOCOLS.find((item) => item.id === protocol)?.package ?? ENDPOINT_PROTOCOLS[0].package

export const protocolOfPackage = (pkg: string | undefined): EndpointProtocol =>
  ENDPOINT_PROTOCOLS.find((item) => item.package === pkg)?.id ?? "openai-compatible"

export interface EndpointDraft {
  readonly name: string
  readonly baseURL: string
  readonly protocol: string
  readonly headers?: Readonly<Record<string, string>>
  /** Manually entered or discovered model ids for this endpoint. */
  readonly modelIDs?: readonly string[]
}

/**
 * Builds the config provider entry for a custom endpoint. The API key is
 * deliberately NOT part of the entry: it is stored through the credential
 * service under the same provider id. Manual/discovered model ids become
 * model entries so the registry (and therefore the picker) sees them.
 * Duplicate model ids collapse.
 */
export function endpointConfig(draft: EndpointDraft): ConfigProvider.Info {
  const models: Record<string, ConfigProvider.Info["models"] extends Record<string, infer M> | undefined ? M : never> =
    {}
  for (const id of draft.modelIDs ?? []) {
    const modelID = id.trim()
    if (modelID) models[modelID] = {}
  }
  return {
    name: draft.name.trim(),
    package: protocolPackage(draft.protocol),
    endpoint: true,
    settings: { baseURL: draft.baseURL },
    ...(draft.headers && Object.keys(draft.headers).length > 0 ? { headers: { ...draft.headers } } : {}),
    ...(Object.keys(models).length > 0 ? { models } : {}),
  } as ConfigProvider.Info
}

/** Model ids declared on an endpoint entry (its manual/discovered catalog), deduplicated, in order. */
export function endpointModelIDs(entry: Pick<ConfigProvider.Info, "models">): string[] {
  return Object.keys(entry.models ?? {})
}

/** Merges discovered ids into an endpoint's declared models without duplicating or dropping manual ones. */
export function mergeEndpointModels(
  entry: ConfigProvider.Info,
  discovered: readonly string[],
): { entry: ConfigProvider.Info; added: string[] } {
  const models = { ...(entry.models ?? {}) }
  const added: string[] = []
  for (const id of discovered) {
    const modelID = id.trim()
    if (!modelID || modelID in models) continue
    models[modelID] = {}
    added.push(modelID)
  }
  return { entry: { ...entry, models }, added }
}
