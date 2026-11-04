import { createMemo, createSignal } from "solid-js"
import { useDialog } from "../ui/dialog"
import { DialogSelect } from "../ui/dialog-select"
import { DialogPrompt } from "../ui/dialog-prompt"
import { DialogConfirm } from "../ui/dialog-confirm"
import { useData } from "../context/data"
import { useLocation } from "../context/location"
import { useClient } from "../context/client"
import { useToast } from "../ui/toast"
import { useT } from "../util/i18n"

/**
 * Model collections & custom endpoints — the management surface.
 *
 * Everything here is a view over data Orchestra already owns: collections
 * and endpoint entries live in the global config document (written through
 * the config patch API, the same channel the picker uses for favorites),
 * endpoint API keys live in the credential store (never in config, never
 * shown), and discovery goes through the server's provider.discover call,
 * which resolves stored keys server-side. Models themselves always come
 * from the live provider/model registry — there is no second registry.
 */

type Collection = { id: string; name: string; enabled: boolean; models: string[] }
type EndpointEntry = {
  name?: string
  package?: string
  endpoint?: boolean
  settings?: { baseURL?: string; [key: string]: unknown }
  headers?: Record<string, string>
  models?: Record<string, unknown>
}

const PROTOCOLS = [
  { id: "openai-compatible", label: "OpenAI-compatible", package: "@orchestra/ai/providers/openai-compatible" },
  { id: "openai", label: "OpenAI", package: "@orchestra/ai/providers/openai" },
  { id: "anthropic", label: "Anthropic", package: "@orchestra/ai/providers/anthropic" },
  { id: "openrouter", label: "OpenRouter", package: "@orchestra/ai/providers/openrouter" },
] as const

const slugify = (name: string, taken: ReadonlySet<string>) => {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "collection"
  if (!taken.has(base)) return base
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`
  return base
}

export function DialogModelCollections() {
  const dialog = useDialog()
  const data = useData()
  const location = useLocation()
  const client = useClient()
  const toast = useToast()
  const t = useT()

  const documents = createMemo(
    () => (data.location.config.list(location.ref) ?? []).filter((entry) => entry.type === "document"),
  )
  const configCollections = createMemo(() => {
    const entry = documents().findLast((entry) => entry.info.model_collections !== undefined)
    const raw = (entry?.info.model_collections ?? []) as ReadonlyArray<Omit<Collection, "enabled"> & { enabled?: boolean }>
    // Documents written before `enabled` existed (or by hand) carry entries without the
    // key. The config schema requires it explicitly, so read them as enabled here: the
    // collection stays visible, and the next save writes the key out in full instead of
    // failing the whole PATCH on the legacy entry.
    return raw.map((item) => ({ ...item, enabled: item.enabled ?? true }))
  })
  const [savedCollections, setSavedCollections] = createSignal<Collection[] | undefined>()
  const collections = createMemo(() => savedCollections() ?? configCollections())

  const configEndpoints = createMemo(() => {
    const merged = new Map<string, EndpointEntry>()
    for (const entry of documents()) {
      for (const [id, value] of Object.entries(entry.info.providers ?? {})) {
        if (value) merged.set(id, value as EndpointEntry)
      }
    }
    return new Map([...merged].filter(([, value]) => value.endpoint === true))
  })
  const [savedEndpoints, setSavedEndpoints] = createSignal<Map<string, EndpointEntry> | undefined>()
  const endpoints = createMemo(() => savedEndpoints() ?? configEndpoints())
  const [status, setStatus] = createSignal(new Map<string, { ok: boolean; text: string }>())

  const providers = createMemo(
    () => new Map((data.location.provider.list(location.ref) ?? []).map((item) => [item.id, item])),
  )
  const models = createMemo(() => data.location.model.list(location.ref) ?? [])
  const modelTitle = (providerID: string, modelID: string) =>
    models().find((model) => model.providerID === providerID && model.id === modelID)?.name ?? modelID

  const saveCollections = (next: Collection[]) => {
    setSavedCollections(next)
    void client.api.config.update({ model_collections: next }).catch((error) => {
      setSavedCollections(undefined)
      toast.error(error)
    })
  }
  const saveEndpoint = (id: string, entry: EndpointEntry | null) => {
    const next = new Map(endpoints())
    if (entry) next.set(id, entry)
    else next.delete(id)
    setSavedEndpoints(next)
    // The entry is built from the config store's own data; the patch payload is
    // validated again server-side by the config Patch schema.
    void client.api.config.update({ providers: { [id]: entry } as never }).catch((error) => {
      setSavedEndpoints(undefined)
      toast.error(error)
    })
  }
  const setEndpointStatus = (id: string, value: { ok: boolean; text: string }) =>
    setStatus((current) => new Map(current).set(id, value))

  /* ------------------------------ views ------------------------------ */

  const root = () => {
    dialog.replace(() => (
      <DialogSelect<string>
        title={t("Model collections & endpoints")}
        options={[
          ...collections().map((collection) => ({
            value: `collection:${collection.id}`,
            title: collection.name,
            description: collection.enabled ? undefined : t("disabled"),
            category: t("Collections"),
            footer: t("{count} models", { count: collection.models.length }),
            onSelect: () => collectionDetail(collection.id),
          })),
          ...[...endpoints()].map(([id, entry]) => ({
            value: `endpoint:${id}`,
            title: entry.name ?? id,
            category: t("Custom endpoints"),
            description: entry.settings?.baseURL,
            footer: status().get(id)?.text ?? t("{count} models", { count: Object.keys(entry.models ?? {}).length }),
            onSelect: () => endpointDetail(id),
          })),
        ]}
        actions={[
          {
            command: "dialog.collections.new",
            title: t("New collection"),
            selection: "none",
            onTrigger: () => {
              dialog.replace(() => (
                <DialogPrompt
                  title={t("New collection")}
                  placeholder={t("Collection name")}
                  onConfirm={(value) => {
                    const name = value.trim()
                    if (!name) return root()
                    const id = slugify(name, new Set(collections().map((item) => item.id)))
                    saveCollections([...collections(), { id, name, enabled: true, models: [] }])
                    collectionDetail(id)
                  }}
                  onCancel={root}
                />
              ))
            },
          },
          {
            command: "dialog.collections.endpoint",
            title: t("New endpoint"),
            selection: "none",
            onTrigger: () => endpointWizard(),
          },
        ]}
        onFilter={() => undefined}
        skipFilter={false}
      />
    ))
  }

  const collectionDetail = (id: string) => {
    const collection = collections().find((item) => item.id === id)
    if (!collection) return root()
    dialog.replace(() => (
      <DialogSelect<string>
        title={collection.name}
        options={collection.models.map((ref) => {
          const slash = ref.indexOf("/")
          const providerID = ref.slice(0, slash)
          const modelID = ref.slice(slash + 1)
          const available = models().some((model) => model.providerID === providerID && model.id === modelID)
          return {
            value: ref,
            title: modelTitle(providerID, modelID),
            description: providers().get(providerID)?.name ?? providerID,
            footer: available ? undefined : t("unavailable"),
          }
        })}
        actions={[
          {
            command: "dialog.collections.add",
            title: t("Add models"),
            selection: "none",
            onTrigger: () => addModels(id),
          },
          {
            command: "dialog.collections.remove",
            title: t("Remove model"),
            onTrigger: (option) => {
              saveCollections(
                collections().map((item) =>
                  item.id === id ? { ...item, models: item.models.filter((ref) => ref !== option.value) } : item,
                ),
              )
              collectionDetail(id)
            },
          },
          {
            command: "dialog.collections.toggle",
            title: collection.enabled ? t("Disable collection") : t("Enable collection"),
            selection: "none",
            onTrigger: () => {
              saveCollections(
                collections().map((item) => (item.id === id ? { ...item, enabled: !item.enabled } : item)),
              )
              collectionDetail(id)
            },
          },
          {
            command: "dialog.collections.rename",
            title: t("Rename"),
            selection: "none",
            onTrigger: () => {
              dialog.replace(() => (
                <DialogPrompt
                  title={t("Rename collection")}
                  value={collection.name}
                  onConfirm={(value) => {
                    const name = value.trim()
                    if (name)
                      saveCollections(collections().map((item) => (item.id === id ? { ...item, name } : item)))
                    collectionDetail(id)
                  }}
                  onCancel={() => collectionDetail(id)}
                />
              ))
            },
          },
          {
            command: "dialog.collections.delete",
            title: t("Delete collection"),
            selection: "none",
            onTrigger: () => {
              dialog.replace(() => (
                <DialogConfirm
                  title={t("Delete collection {name}?", { name: collection.name })}
                  message={t("The models stay available; only the collection is removed.")}
                  onConfirm={() => {
                    saveCollections(collections().filter((item) => item.id !== id))
                    root()
                  }}
                  onCancel={() => collectionDetail(id)}
                />
              ))
            },
          },
          { command: "dialog.collections.back", title: t("Back"), selection: "none", onTrigger: root },
        ]}
        onFilter={() => undefined}
      />
    ))
  }

  const addModels = (collectionID: string) => {
    const collection = collections().find((item) => item.id === collectionID)
    if (!collection) return root()
    const have = new Set(collection.models)
    dialog.replace(() => (
      <DialogSelect<string>
        title={t("Add models to {name}", { name: collection.name })}
        options={models()
          .filter((model) => model.status !== "deprecated")
          .map((model) => {
            const ref = `${model.providerID}/${model.id}`
            return {
              value: ref,
              title: model.name,
              category: providers().get(model.providerID)?.name ?? model.providerID,
              description: have.has(ref) ? t("in collection") : undefined,
              onSelect: () => {
                if (have.has(ref)) return
                saveCollections(
                  collections().map((item) =>
                    item.id === collectionID ? { ...item, models: [...item.models, ref] } : item,
                  ),
                )
                addModels(collectionID)
              },
            }
          })}
        actions={[
          { command: "dialog.collections.done", title: t("Done"), selection: "none", onTrigger: () => collectionDetail(collectionID) },
        ]}
        onFilter={() => undefined}
      />
    ))
  }

  /* ---------------------------- endpoints ---------------------------- */

  const endpointWizard = (draft: { name?: string; baseURL?: string; protocol?: string; apiKey?: string } = {}) => {
    if (!draft.name) {
      dialog.replace(() => (
        <DialogPrompt
          title={t("New endpoint — name")}
          placeholder={t("e.g. Local vLLM")}
          onConfirm={(value) => {
            const name = value.trim()
            if (!name) return root()
            endpointWizard({ ...draft, name })
          }}
          onCancel={root}
        />
      ))
      return
    }
    if (!draft.baseURL) {
      dialog.replace(() => (
        <DialogPrompt
          title={t("New endpoint — base URL")}
          placeholder="https://api.example.com/v1"
          onConfirm={(value) => {
            const baseURL = value.trim().replace(/\/+$/, "")
            if (!baseURL) return root()
            endpointWizard({ ...draft, baseURL })
          }}
          onCancel={root}
        />
      ))
      return
    }
    if (!draft.protocol) {
      dialog.replace(() => (
        <DialogSelect<string>
          title={t("New endpoint — protocol")}
          options={PROTOCOLS.map((protocol) => ({
            value: protocol.id,
            title: protocol.label,
            onSelect: () => endpointWizard({ ...draft, protocol: protocol.id }),
          }))}
          onFilter={() => undefined}
          skipFilter={true}
        />
      ))
      return
    }
    if (draft.apiKey === undefined) {
      dialog.replace(() => (
        <DialogPrompt
          title={t("New endpoint — API key (optional)")}
          placeholder={t("Stored as a credential; leave empty for keyless endpoints")}
          onConfirm={(value) => endpointWizard({ ...draft, apiKey: value.trim() })}
          onCancel={root}
        />
      ))
      return
    }
    const id = slugify(draft.name, new Set([...providers().keys(), ...endpoints().keys()]))
    const protocol = PROTOCOLS.find((item) => item.id === draft.protocol) ?? PROTOCOLS[0]
    const entry: EndpointEntry = {
      name: draft.name,
      package: protocol.package,
      endpoint: true,
      settings: { baseURL: draft.baseURL },
      models: {},
    }
    saveEndpoint(id, entry)
    if (draft.apiKey) {
      void client.api.credential
        .create({
          integrationID: id,
          value: { type: "key", key: draft.apiKey },
          label: draft.name,
          activate: true,
        })
        .catch(toast.error)
    }
    toast.show({ variant: "success", message: t("Endpoint {name} created", { name: draft.name }) })
    endpointDetail(id, draft.apiKey || undefined)
  }

  const endpointDetail = (id: string, justTypedKey?: string) => {
    const entry = endpoints().get(id)
    if (!entry) return root()
    const modelIDs = Object.keys(entry.models ?? {})
    dialog.replace(() => (
      <DialogSelect<string>
        title={entry.name ?? id}
        options={[
          {
            value: "meta",
            title: entry.settings?.baseURL ?? "",
            description: PROTOCOLS.find((item) => item.package === entry.package)?.label ?? entry.package,
            footer: status().get(id)?.text,
          },
          ...modelIDs.map((modelID) => ({
            value: `model:${modelID}`,
            title: modelID,
            category: t("Models"),
          })),
        ]}
        actions={[
          {
            command: "dialog.endpoint.test",
            title: t("Test & fetch models"),
            selection: "none",
            onTrigger: () => {
              setEndpointStatus(id, { ok: true, text: t("testing…") })
              endpointDetail(id, justTypedKey)
              void client.api.provider
                .discover({
                  baseURL: entry.settings?.baseURL ?? "",
                  ...(justTypedKey ? { apiKey: justTypedKey } : { providerID: id }),
                  ...(entry.headers ? { headers: entry.headers } : {}),
                })
                .then((result) => {
                  if (result.ok) {
                    setEndpointStatus(id, {
                      ok: true,
                      text: t("connected · {count} models · {ms} ms", {
                        count: result.models.length,
                        ms: Math.round(result.latencyMs ?? 0),
                      }),
                    })
                    const merged = { ...(entry.models ?? {}) }
                    let added = 0
                    for (const model of result.models) {
                      if (!(model.id in merged)) {
                        merged[model.id] = {}
                        added++
                      }
                    }
                    if (added > 0) {
                      saveEndpoint(id, { ...entry, models: merged })
                      toast.show({
                        variant: "success",
                        message: t("Imported {count} new models into {name}", { count: added, name: entry.name ?? id }),
                      })
                    }
                  } else {
                    setEndpointStatus(id, {
                      ok: false,
                      text: result.error?.message ?? t("discovery failed"),
                    })
                    toast.show({ variant: "error", message: result.error?.message ?? t("discovery failed") })
                  }
                  endpointDetail(id, justTypedKey)
                })
                .catch((error) => {
                  setEndpointStatus(id, { ok: false, text: t("request failed") })
                  toast.error(error)
                  endpointDetail(id, justTypedKey)
                })
            },
          },
          {
            command: "dialog.endpoint.add",
            title: t("Add model manually"),
            selection: "none",
            onTrigger: () => {
              dialog.replace(() => (
                <DialogPrompt
                  title={t("Model ID")}
                  placeholder="llama-3.1-70b"
                  onConfirm={(value) => {
                    const modelID = value.trim()
                    if (modelID && !(modelID in (entry.models ?? {})))
                      saveEndpoint(id, { ...entry, models: { ...(entry.models ?? {}), [modelID]: {} } })
                    endpointDetail(id, justTypedKey)
                  }}
                  onCancel={() => endpointDetail(id, justTypedKey)}
                />
              ))
            },
          },
          {
            command: "dialog.endpoint.remove",
            title: t("Remove model"),
            onTrigger: (option) => {
              if (!option.value.startsWith("model:")) return
              const models = { ...(entry.models ?? {}) }
              delete models[option.value.slice("model:".length)]
              saveEndpoint(id, { ...entry, models })
              endpointDetail(id, justTypedKey)
            },
          },
          {
            command: "dialog.endpoint.delete",
            title: t("Delete endpoint"),
            selection: "none",
            onTrigger: () => {
              dialog.replace(() => (
                <DialogConfirm
                  title={t("Delete endpoint {name}?", { name: entry.name ?? id })}
                  message={t("Its stored API key credential is removed as well. Collections keep their model refs.")}
                  onConfirm={() => {
                    saveEndpoint(id, null)
                    void client.api.credential
                      .list()
                      .then((entries) =>
                        Promise.all(
                          entries
                            .filter((item) => item.integrationID === id)
                            .map((item) => client.api.credential.remove({ credentialID: item.id })),
                        ),
                      )
                      .catch(() => undefined)
                    root()
                  }}
                  onCancel={() => endpointDetail(id, justTypedKey)}
                />
              ))
            },
          },
          { command: "dialog.endpoint.back", title: t("Back"), selection: "none", onTrigger: root },
        ]}
        onFilter={() => undefined}
      />
    ))
  }

  root()
  return null
}
