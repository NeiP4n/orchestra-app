import { createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js"
import { TextAttributes } from "@opentui/core"
import { useLocal } from "../context/local"
import { DialogSelect } from "../ui/dialog-select"
import { CategoryRail } from "../ui/category-rail"
import { useDialog } from "../ui/dialog"
import { useTheme } from "../context/theme"
import { DialogIntegration } from "./dialog-integration"
import { DialogModelCollections } from "./dialog-model-collections"
import { DialogVariant } from "./dialog-variant"
import * as fuzzysort from "fuzzysort"
import { useConnected } from "./use-connected"
import { useData } from "../context/data"
import { modelPreferenceKey, mergeModelFavorites } from "../model-preference"
import { useLocation } from "../context/location"
import { useClient } from "../context/client"
import { useToast } from "../ui/toast"
import { useT } from "../util/i18n"
import {
  FREEBUFF_PROVIDER_ID,
  freebuffFooter,
  type FreebuffPricing,
  type Translate,
} from "../util/freebuff-price"

// Freebuff charges freebucks per session, so the picker has to show the price of a
// model and the balance left before the user picks one. The core plugin resolves the
// catalog rows to the account's price table and answers with both.
const FREEBUFF_RPC_ID = "orchestra.freebuff"

interface FreebuffStatusResponse {
  readonly balance?: number
  readonly prices?: ReadonlyArray<{ readonly key: string; readonly price?: number }>
}

type ModelSearchOption = {
  value: { providerID: string; modelID: string }
  title: string
  category?: string | undefined
  releaseDate: string | number
  footer?: string | undefined
}

const CATEGORY_ALL = "all"
const CATEGORY_FEATURE = "feature"
const CATEGORY_RECENT = "recent"
const collectionCategoryID = (name: string) => `collection:${name}`
const providerCategoryID = (providerID: string) => `provider:${providerID}`

// With onPick the choice goes to the caller (the global default model) instead of the
// current session's selection.
export function DialogModel(props: {
  providerID?: string
  title?: string
  onPick?: (model: { providerID: string; modelID: string }) => void
}) {
  const local = useLocal()
  const data = useData()
  const dialog = useDialog()
  const location = useLocation()
  const client = useClient()
  const toast = useToast()
  const t = useT()
  const theme = useTheme().surface("dialog")
  const [query, setQuery] = createSignal("")
  const [selectedCategory, setSelectedCategory] = createSignal(CATEGORY_ALL)
  // The categorized picker needs the room the rail takes, like Ctrl+P.
  onMount(() => {
    if (!props.providerID) dialog.setSize("large")
  })
  onCleanup(() => dialog.setSize("medium"))
  // Favorites are shared through the server config, so every client of the same server lists
  // the same models; this machine's model.json adds the ones pinned before the config existed.
  const configFavorites = createMemo(() => {
    const entry = data.location.config
      .list(location.ref)
      ?.findLast((entry) => entry.type === "document" && entry.info.model_favorites !== undefined)
    return entry?.type === "document" ? entry.info.model_favorites : undefined
  })
  // A toggle lands on screen before the server answers, so a row never flickers out; the
  // saved list gives way as soon as the config store carries the new value.
  const [savedFavorites, setSavedFavorites] = createSignal<Array<{ providerID: string; modelID: string }> | undefined>()
  createEffect(on(configFavorites, () => setSavedFavorites(undefined), { defer: true }))
  const favoriteModels = createMemo(
    () => savedFavorites() ?? mergeModelFavorites(configFavorites() ?? [], local.model.favorite()),
  )
  // Collections are shared through the same server config document as favorites:
  // each enabled collection becomes its own picker section, resolved live against
  // the model list (entries whose provider/model is gone simply do not render).
  const configCollections = createMemo(() => {
    const entry = data.location.config
      .list(location.ref)
      ?.findLast((entry) => entry.type === "document" && entry.info.model_collections !== undefined)
    if (entry?.type !== "document") return undefined
    // Same legacy retrofit as the collections manager: an entry written before `enabled`
    // existed reads as enabled, not as a hidden collection.
    return entry.info.model_collections?.map((item) => ({ ...item, enabled: item.enabled ?? true }))
  })
  const favoritePriority = createMemo(() => new Set(favoriteModels().map(modelPreferenceKey)))
  const [freebuffPricing, setFreebuffPricing] = createSignal<FreebuffPricing | undefined>()

  const connected = useConnected()
  const providers = createMemo(
    () => new Map((data.location.provider.list(location.ref) ?? []).map((item) => [item.id, item])),
  )
  const models = createMemo(() => data.location.model.list(location.ref) ?? [])
  // Providers whose active access choice is an OAuth account instead of an API key.
  // `connections` lists stored credentials before environment names and the active one first.
  const subscriptions = createMemo(() => {
    const accounts = new Set(
      (data.location.integration.list(location.ref) ?? [])
        .filter((integration) => {
          const connection = integration.connections[0]
          return connection?.type === "credential" && connection.method === "oauth"
        })
        .map((integration) => integration.id),
    )
    return new Set(
      Array.from(providers().values())
        // The same integration key the server uses to decide whether a provider is available.
        .filter((provider) => accounts.has(provider.integrationID ?? provider.id))
        .map((provider) => provider.id),
    )
  })

  const showExtra = createMemo(() => connected() && !props.providerID)

  // The Freebuff balance and its price table live behind the provider's own RPC, so
  // they are fetched once per picker open and only when Freebuff rows are on screen.
  onMount(() => {
    if (!models().some((model) => model.providerID === FREEBUFF_PROVIDER_ID)) return
    void client.api.rpc
      .call({ rpcID: FREEBUFF_RPC_ID, method: "status", input: {} })
      .then((result) => {
        const output = result.output as FreebuffStatusResponse | undefined
        if (!output) return
        const prices: Record<string, number> = {}
        for (const entry of output.prices ?? []) {
          if (typeof entry.price === "number") prices[entry.key] = entry.price
        }
        setFreebuffPricing({
          prices,
          ...(typeof output.balance === "number" ? { balance: output.balance } : {}),
        })
      })
      .catch(() => undefined)
  })

  // The picker browses by category, like Ctrl+P and /settings: the rail picks
  // the group (Feature, a collection, Recent, or one provider), the list beside
  // it shows only that group, and search narrows within the selected category
  // (All searches everything). This memo builds every group once; the options
  // memo below picks what the current category and query show.
  const parts = createMemo(() => {
    const favorites = connected() ? favoriteModels() : []
    const recents = local.model.recent()

    function toOptions(items: typeof favorites, category: string) {
      if (!showExtra()) return []
      return items.flatMap((item) => {
        const model = models().find((model) => model.providerID === item.providerID && model.id === item.modelID)
        if (!model) return []
        const provider = providers().get(model.providerID)
        return [
          {
            key: item,
            value: { providerID: model.providerID, modelID: model.id },
            title: model.name,
            releaseDate: model.time.released,
            description: provider?.name ?? model.providerID,
            category,
            footer: modelFooter(model, subscriptions(), freebuffPricing(), t),
            // While searching, the dialog shows the search footer instead of the
            // category, so the price of a Freebuff row has to travel with it.
            searchFooter: modelFooter(model, subscriptions(), freebuffPricing(), t),
            onSelect: () => {
              onSelect(model.providerID, model.id)
            },
          },
        ]
      })
    }

    const favoriteOptions = toOptions(favorites, "Feature")
    // Enabled collections, in config order. A model already placed in Feature or an
    // earlier collection is not repeated in a later section.
    const placed = new Set(favorites.map(modelPreferenceKey))
    const collectionOptions = (connected() ? (configCollections() ?? []) : []).flatMap((collection) => {
      if (!collection.enabled) return []
      const items: Array<{ providerID: string; modelID: string }> = []
      for (const ref of collection.models) {
        const slash = ref.indexOf("/")
        if (slash <= 0) continue
        const item = { providerID: ref.slice(0, slash), modelID: ref.slice(slash + 1) }
        if (placed.has(modelPreferenceKey(item))) continue
        placed.add(modelPreferenceKey(item))
        items.push(item)
      }
      return toOptions(items, collection.name)
    })
    const recentOptions = toOptions(
      recents.filter((item) => !placed.has(modelPreferenceKey(item))),
      "Recent",
    )
    recents.forEach((item) => placed.add(modelPreferenceKey(item)))

    const allModelOptions = sortModelOptions(
      models()
        .filter((model) => model.status !== "deprecated")
        .filter((model) => (props.providerID ? model.providerID === props.providerID : true))
        .map((model) => {
          const provider = providers().get(model.providerID)
          const key = modelPreferenceKey({ providerID: model.providerID, modelID: model.id })
          const favorite = favorites.some((item) => modelPreferenceKey(item) === key)
          return {
            value: { providerID: model.providerID, modelID: model.id },
            providerID: model.providerID,
            providerName: provider?.name ?? model.providerID,
            title: model.name,
            releaseDate: model.time.released,
            description: favorite ? "(Favorite)" : undefined,
            category: connected() ? (provider?.name ?? model.providerID) : undefined,
            footer: modelFooter(model, subscriptions(), freebuffPricing(), t),
            // While searching, the dialog shows the search footer instead of the
            // category, so the provider and the price of a Freebuff row both have to
            // travel with it.
            searchFooter: [provider?.name ?? model.providerID, modelFooter(model, subscriptions(), freebuffPricing(), t)]
              .filter(Boolean)
              .join(" · "),
            onSelect() {
              onSelect(model.providerID, model.id)
            },
          }
        }),
      connected(),
    )

    // In the All view a model already placed in Feature, a collection section
    // or Recent is not repeated in its provider group. A provider category
    // browses the provider's full list, so it reads allModelOptions instead.
    const modelOptions = showExtra()
      ? allModelOptions.filter((option) => !placed.has(modelPreferenceKey(option.value)))
      : allModelOptions

    return { favoriteOptions, collectionOptions, recentOptions, allModelOptions, modelOptions }
  })

  const categories = createMemo(() => {
    if (!showExtra()) return []
    const built = parts()
    const items: Array<{ id: string; label: string; count: number }> = [
      {
        id: CATEGORY_ALL,
        label: t("All"),
        count:
          built.favoriteOptions.length +
          built.collectionOptions.length +
          built.recentOptions.length +
          built.modelOptions.length,
      },
    ]
    if (built.favoriteOptions.length > 0)
      items.push({ id: CATEGORY_FEATURE, label: t("Feature"), count: built.favoriteOptions.length })
    const collectionCounts = new Map<string, number>()
    for (const option of built.collectionOptions)
      collectionCounts.set(option.category, (collectionCounts.get(option.category) ?? 0) + 1)
    for (const [name, count] of collectionCounts) items.push({ id: collectionCategoryID(name), label: name, count })
    if (built.recentOptions.length > 0)
      items.push({ id: CATEGORY_RECENT, label: t("Recent"), count: built.recentOptions.length })
    const providerCounts = new Map<string, { label: string; count: number }>()
    for (const option of built.allModelOptions) {
      const entry = providerCounts.get(option.providerID) ?? { label: option.providerName, count: 0 }
      entry.count++
      providerCounts.set(option.providerID, entry)
    }
    for (const [providerID, entry] of providerCounts)
      items.push({ id: providerCategoryID(providerID), label: entry.label, count: entry.count })
    return items
  })

  const activeCategory = createMemo(
    () => categories().find((category) => category.id === selectedCategory()) ?? categories()[0],
  )

  function cycleCategory(direction: number) {
    const cats = categories()
    if (cats.length === 0) return
    const idx = cats.findIndex((category) => category.id === activeCategory()?.id)
    setSelectedCategory(cats[(idx + direction + cats.length) % cats.length].id)
  }

  function categorySubset(id: string, built: ReturnType<typeof parts>): ModelSearchOption[] {
    if (id === CATEGORY_FEATURE) return built.favoriteOptions
    if (id === CATEGORY_RECENT) return built.recentOptions
    if (id.startsWith("collection:")) {
      const name = id.slice("collection:".length)
      return built.collectionOptions.filter((option) => option.category === name)
    }
    if (id.startsWith("provider:")) {
      const providerID = id.slice("provider:".length)
      return built.allModelOptions.filter((option) => option.providerID === providerID)
    }
    return built.allModelOptions
  }

  const options = createMemo(() => {
    const needle = query().trim()
    const built = parts()
    const category = activeCategory()?.id ?? CATEGORY_ALL

    if (needle) {
      const pool: ModelSearchOption[] =
        !showExtra() || category === CATEGORY_ALL ? built.allModelOptions : categorySubset(category, built)
      return prioritizeFavorites(
        sortModelOptions(
          fuzzysort.go(needle, pool, { keys: ["title", "category"] }).map((item) => item.obj),
          false,
        ),
        favoritePriority(),
      )
    }

    if (!showExtra() || category === CATEGORY_ALL)
      return [...built.favoriteOptions, ...built.collectionOptions, ...built.recentOptions, ...built.modelOptions]
    return categorySubset(category, built)
  })

  const provider = createMemo(() => (props.providerID ? providers().get(props.providerID) : undefined))

  const title = createMemo(() => {
    const value = provider()
    if (!value) return props.title ?? "Select model"
    return value.name
  })

  function onSelect(providerID: string, modelID: string) {
    if (props.onPick) {
      dialog.clear()
      props.onPick({ providerID, modelID })
      return
    }
    local.model.set({ providerID, modelID }, { recent: true })
    const list = local.model.variant.list()
    const cur = local.model.variant.current()
    if (cur && list.includes(cur)) {
      dialog.clear()
      return
    }
    if (list.length > 0) {
      dialog.replace(() => <DialogVariant />)
      return
    }
    dialog.clear()
  }

  // The picker is the one writer of favorites: the server config holds the shared list, and
  // model.json mirrors it because the shift+tab cycle reads favorites from there.
  function toggleFavorite(model: { providerID: string; modelID: string }) {
    const key = modelPreferenceKey(model)
    const enabled = !favoriteModels().some((item) => modelPreferenceKey(item) === key)
    const next = enabled
      ? [...favoriteModels(), model]
      : favoriteModels().filter((item) => modelPreferenceKey(item) !== key)
    const localFavorite = local.model.favorite().some((item) => modelPreferenceKey(item) === key)
    if (localFavorite !== enabled) local.model.toggleFavorite(model)
    setSavedFavorites(next)
    void client.api.config.update({ model_favorites: next.map(modelPreferenceKey) }).catch(() => {
      setSavedFavorites(undefined)
      toast.show({ variant: "error", message: t("Failed to save favorite models") })
    })
  }

  const select = (
    <DialogSelect<ReturnType<typeof options>[number]["value"]>
      compact
      tall
      options={options()}
      actions={[
        {
          command: "model.dialog.provider",
          title: connected() ? "Подключить" : "Интеграции",
          selection: "none",
          onTrigger() {
            dialog.replace(() => (
              <DialogIntegration
                onConnected={(providerID) =>
                  dialog.replace(() => <DialogModel providerID={providerID} title={props.title} onPick={props.onPick} />)
                }
              />
            ))
          },
        },
        {
          command: "model.dialog.favorite",
          title: "Избранное",
          hidden: !connected(),
          onTrigger: (option) => toggleFavorite(option.value),
        },
        {
          command: "model.dialog.collections",
          title: "Коллекции",
          selection: "none",
          hidden: !connected(),
          onTrigger() {
            dialog.replace(() => <DialogModelCollections />)
          },
        },
      ]}
      onFilter={setQuery}
      flat={true}
      skipFilter={true}
      title={title()}
      titleView={
        showExtra() ? (
          <box flexDirection="row" gap={1} alignItems="center">
            <text fg={theme.text.base} attributes={TextAttributes.BOLD} wrapMode="none">
              {activeCategory()?.label ?? t("All")}
            </text>
            <text fg={theme.text.muted} wrapMode="none">{`· ${options().length} ${t("options")}`}</text>
            <text fg={theme.text.muted} wrapMode="none">{`· tab ${t("category")}`}</text>
          </box>
        ) : undefined
      }
      bindings={
        showExtra()
          ? [
              { bind: "tab", title: "Next category", group: "Dialog", run: () => cycleCategory(1) },
              { bind: "shift+tab", title: "Previous category", group: "Dialog", run: () => cycleCategory(-1) },
            ]
          : undefined
      }
      current={local.model.current()}
      focusCurrent={false}
    />
  )

  if (!showExtra()) return select

  return (
    <box flexDirection="row" width="100%" minWidth={0}>
      <CategoryRail
        width={20}
        items={categories()}
        selected={activeCategory()?.id ?? CATEGORY_ALL}
        onSelect={setSelectedCategory}
      />
      <box flexDirection="column" flexGrow={1} flexBasis={0} minWidth={0}>{select}</box>
    </box>
  )
}

export function prioritizeFavorites<T extends { value: { providerID: string; modelID: string } }>(
  options: T[],
  favorites: Set<string>,
) {
  return options.toSorted(
    (a, b) => Number(favorites.has(modelPreferenceKey(b.value))) - Number(favorites.has(modelPreferenceKey(a.value))),
  )
}

export function sortModelOptions<
  T extends {
    providerID?: string
    providerName?: string
    releaseDate: string | number
    title: string
    footer?: string
  },
>(options: T[], grouped = true) {
  return options.toSorted((a, b) => {
    const isGo = (id?: string) => id === "orchestra-go" || id === "opencode-go"
    const isPrimary = (id?: string) => id === "orchestra" || id === "opencode"
    const provider = grouped
      ? Number(isGo(b.providerID)) - Number(isGo(a.providerID)) ||
        Number(isPrimary(b.providerID)) - Number(isPrimary(a.providerID))
      : 0
    if (provider !== 0) return provider

    const name = grouped ? (a.providerName ?? "").localeCompare(b.providerName ?? "") : 0
    if (name !== 0) return name

    const free = Number(b.footer === "Free") - Number(a.footer === "Free")
    if (free !== 0) return free

    const release = Number(b.releaseDate) - Number(a.releaseDate)
    if (release !== 0) return release

    return a.title.localeCompare(b.title)
  })
}

function free(model: { cost: Array<{ input: number }> }) {
  return model.cost.length > 0 && model.cost.every((cost) => cost.input === 0)
}

// Models a provider lists but cannot serve on this account (subscription tiers,
// unsupported endpoints) stay in the list so their name is discoverable.
export function modelFooter(
  model: { id: string; cost: Array<{ input: number }>; enabled: boolean; providerID: string },
  subscriptions: ReadonlySet<string>,
  freebuff?: FreebuffPricing,
  t: Translate = (text) => text,
) {
  // Freebuff rows are priced in freebucks, not per token, so their zero token cost
  // says nothing about what a session costs. Show the real price instead.
  if (model.providerID === FREEBUFF_PROVIDER_ID)
    return freebuffFooter(model, freebuff, t)
  if (!model.enabled) return "Locked"
  if (free(model)) return "Free"
  // An empty cost array plus an OAuth account means the account covers usage: provider
  // plugins empty `cost` for subscription models (`draft.cost = []` in the OpenAI and
  // ChatGPT plugins). Empty cost alone stays unlabelled because it can also mean the
  // price is unknown, and an account alone can also fund per-token billing.
  if (model.cost.length === 0 && subscriptions.has(model.providerID)) return t("Subscription")
  return undefined
}
