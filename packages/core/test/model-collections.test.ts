import { describe, expect, test } from "bun:test"
import {
  addModels,
  createCollection,
  endpointConfig,
  endpointModelIDs,
  mergeEndpointModels,
  normalizeCollections,
  pickerRefs,
  protocolOfPackage,
  removeCollection,
  removeModel,
  renameCollection,
  resolveCollections,
  setCollectionEnabled,
  slugify,
} from "../src/model-collections"

const base = normalizeCollections([
  { id: "work", name: "Work", enabled: true, models: ["openai/gpt-x", "openai/gpt-x", "bad ref", "ollama/llama"] },
  { id: "off", name: "Off", enabled: false, models: ["openai/gpt-x"] },
])

describe("normalizeCollections", () => {
  test("dedupes refs, drops invalid refs and keeps order", () => {
    expect(base[0].models).toEqual(["openai/gpt-x", "ollama/llama"])
    expect(base).toHaveLength(2)
  })

  test("slugify is stable and unique", () => {
    expect(slugify("My Models!", new Set())).toBe("my-models")
    expect(slugify("My Models", new Set(["my-models"]))).toBe("my-models-2")
    expect(slugify("!!!", new Set())).toBe("collection")
  })
})

describe("collection editing", () => {
  test("create, rename, toggle, delete", () => {
    let list = createCollection(base, "Research")
    expect(list.at(-1)).toMatchObject({ name: "Research", enabled: true, models: [] })
    const id = list.at(-1)!.id
    list = renameCollection(list, id, "Deep Research")
    expect(list.at(-1)?.name).toBe("Deep Research")
    list = setCollectionEnabled(list, id, false)
    expect(list.at(-1)?.enabled).toBe(false)
    list = removeCollection(list, id)
    expect(list.some((item) => item.id === id)).toBe(false)
  })

  test("addModels dedupes against existing and within the batch; removeModel is exact", () => {
    const { collections, added } = addModels(base, "work", ["openai/gpt-x", "xai/grok", "xai/grok", "nope"])
    expect(added).toEqual(["xai/grok"])
    expect(collections[0].models).toEqual(["openai/gpt-x", "ollama/llama", "xai/grok"])
    const after = removeModel(collections, "work", "xai/grok")
    expect(after[0].models).toEqual(["openai/gpt-x", "ollama/llama"])
  })
})

describe("resolution against the live registry", () => {
  const available = new Map<string, ReadonlySet<string>>([
    ["openai", new Set(["gpt-x"])],
    ["ollama", new Set(["llama"])],
  ])

  test("resolved and missing split cleanly", () => {
    const [work] = resolveCollections(base, available)
    expect(work.resolved).toEqual(["openai/gpt-x", "ollama/llama"])
    expect(work.missing).toEqual([])
    const gone = resolveCollections(
      [{ id: "c", name: "C", enabled: true, models: ["gone/model", "openai/gpt-x"] }],
      available,
    )
    expect(gone[0].missing).toEqual(["gone/model"])
    expect(gone[0].resolved).toEqual(["openai/gpt-x"])
  })

  test("the picker offers enabled collections only", () => {
    const offered = pickerRefs(base, available)
    expect(offered.map((entry) => entry.collection.id)).toEqual(["work"])
  })
})

describe("custom endpoints", () => {
  test("endpointConfig carries no key material and dedupes manual models", () => {
    const entry = endpointConfig({
      name: "Local vLLM",
      baseURL: "http://localhost:8000/v1",
      protocol: "openai-compatible",
      headers: { "x-tenant": "a" },
      modelIDs: ["llama-3", "llama-3", " qwen "],
    })
    expect(entry.endpoint).toBe(true)
    expect(entry.package).toBe("@orchestra/ai/providers/openai-compatible")
    expect(entry.settings).toEqual({ baseURL: "http://localhost:8000/v1" })
    expect(JSON.stringify(entry)).not.toContain("apiKey")
    expect(endpointModelIDs(entry)).toEqual(["llama-3", "qwen"])
    expect(protocolOfPackage(entry.package)).toBe("openai-compatible")
  })

  test("mergeEndpointModels adds discovered ids without dropping manual ones", () => {
    const entry = endpointConfig({ name: "E", baseURL: "https://x", protocol: "openai", modelIDs: ["manual"] })
    const { entry: merged, added } = mergeEndpointModels(entry, ["manual", "found-1", "found-2"])
    expect(added).toEqual(["found-1", "found-2"])
    expect(endpointModelIDs(merged)).toEqual(["manual", "found-1", "found-2"])
  })
})
