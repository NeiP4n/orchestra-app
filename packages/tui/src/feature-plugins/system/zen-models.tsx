import { Plugin } from "@orchestra/plugin/tui"
import { For, Show, createSignal } from "solid-js"
import { FoldHeader } from "../../component/fold-header"
import { classifyFailure, freeZenModels, ZEN_PROVIDER_ID, type ZenModelCheck } from "./zen-models-core"
import { hoverBackground } from "../../ui/hover"

type CheckState = { checks: Record<string, ZenModelCheck>; running: boolean; checkedAt?: number }

const INITIAL: CheckState = { checks: {}, running: false }
// Each check is a real model request, so a handful run at once to keep a refresh quick without a burst.
const CONCURRENCY = 4
const PROMPT = "Reply with the single word OK."

function text(context: Plugin.Context, en: string, russian: string) {
  return context.ui.language() === "ru" ? russian : en
}

function Panel(props: {
  context: Plugin.Context
  state: () => CheckState
  models: () => ReturnType<typeof freeZenModels>
  refresh: () => void
  autoFallbackEnabled: boolean
  toggleAutoFallback: () => void
  expanded: boolean
  toggleExpanded: () => void
}) {
  const theme = () => props.context.theme
  const label = (en: string, russian: string) => text(props.context, en, russian)
  const [hovered, setHovered] = createSignal(false)
  const [fallbackHovered, setFallbackHovered] = createSignal(false)
  const [showAll, setShowAll] = createSignal(false)
  const check = (id: string): ZenModelCheck => props.state().checks[id] ?? { state: "unchecked" }
  const working = () => props.models().filter((model) => check(model.modelID).state === "ok")
  const rank = { ok: 0, checking: 1, unchecked: 2, limit: 3, error: 4 }
  const rows = () => {
    const sorted = props.models().toSorted((a, b) => rank[check(a.modelID).state] - rank[check(b.modelID).state])
    return showAll() || !props.state().checkedAt ? sorted : sorted.filter((model) => check(model.modelID).state !== "limit" && check(model.modelID).state !== "error")
  }
  const hidden = () => props.models().length - rows().length
  const status = (value: ZenModelCheck) => {
    if (value.state === "ok") return { text: (value.latencyMs / 1000).toFixed(1) + "s", color: theme().text.feedback.success.base, mark: "✓" }
    if (value.state === "limit") return { text: label("limit", "лимит"), color: theme().text.feedback.warning.base, mark: "✗" }
    if (value.state === "error") return { text: label("error", "ошибка"), color: theme().text.feedback.error.base, mark: "✗" }
    if (value.state === "checking") return { text: "…", color: theme().text.feedback.info.base, mark: "·" }
    return { text: "—", color: theme().text.muted, mark: "·" }
  }
  const actionColor = () => hovered() ? theme().text.action?.primary?.hovered ?? theme().text.base : theme().text.action?.primary?.base ?? theme().text.base
  return (
    <box gap={1}>
      <FoldHeader
        id="zen.sidebar.fold"
        title={label("FREE ZEN MODELS", "БЕСПЛАТНЫЕ ZEN")}
        open={props.expanded}
        onToggle={props.toggleExpanded}
        summary={
          <Show when={props.state().checkedAt}>
            <text fg={working().length > 0 ? theme().text.feedback.success.base : theme().text.feedback.warning.base} wrapMode="none">
              {working().length + "/" + props.models().length + " ✓"}
            </text>
          </Show>
        }
      />
      <Show when={props.expanded}>
      <box paddingLeft={1} paddingRight={1} backgroundColor={!props.state().running && hovered() ? hoverBackground(theme()) : undefined}
        onMouseOver={() => setHovered(!props.state().running)} onMouseOut={() => setHovered(false)}
        onMouseUp={(event) => { event.stopPropagation(); if (!props.state().running) props.refresh() }}>
        <text fg={props.state().running ? theme().text.muted : actionColor()} wrapMode="none" truncate>
          <b>{props.state().running ? label("Checking…", "Проверка…") : label("↻ Check connection", "↻ Проверить подключение")}</b>
        </text>
      </box>
      <box
        paddingLeft={1}
        paddingRight={1}
        backgroundColor={fallbackHovered() ? hoverBackground(theme()) : undefined}
        onMouseOver={() => setFallbackHovered(true)}
        onMouseOut={() => setFallbackHovered(false)}
        onMouseUp={(event) => {
          event.stopPropagation()
          props.toggleAutoFallback()
        }}
      >
        <text fg={props.autoFallbackEnabled ? theme().text.feedback.success.base : theme().text.muted} wrapMode="none" truncate>
          <b>{label(props.autoFallbackEnabled ? "Auto Fallback: ON" : "Auto Fallback: OFF", props.autoFallbackEnabled ? "Автооткат моделей: ВКЛ" : "Автооткат моделей: ВЫКЛ")}</b>
        </text>
      </box>
      <Show when={props.models().length === 0}>
        <text fg={theme().text.muted} wrapMode="word">{label("No free Zen models in the catalog.", "В каталоге нет бесплатных моделей Zen.")}</text>
      </Show>
      <box>
        <For each={rows()}>
          {(model) => {
            const value = () => status(check(model.modelID))
            const detail = () => { const current = check(model.modelID); return current.state === "limit" || current.state === "error" ? current.detail : "" }
            return (
              <box flexDirection="row" gap={1}>
                <text fg={value().color} wrapMode="none">{value().mark}</text>
                <box flexGrow={1} minWidth={0}>
                  <text fg={check(model.modelID).state === "ok" ? theme().text.base : theme().text.muted} wrapMode="none" truncate>{model.name}</text>
                  <Show when={showAll() && detail()}>
                    <text fg={theme().text.muted} wrapMode="none" truncate>{detail()}</text>
                  </Show>
                </box>
                <text fg={value().color} wrapMode="none">{value().text}</text>
              </box>
            )
          }}
        </For>
      </box>
      <Show when={props.state().checkedAt && (hidden() > 0 || showAll())}>
        <box onMouseUp={(event) => { event.stopPropagation(); setShowAll(!showAll()) }}>
          <text fg={theme().text.muted} wrapMode="none" truncate>
            {showAll() ? label("Hide refused", "Скрыть недоступные") : label("+" + hidden() + " refused · show", "+" + hidden() + " недоступны · показать")}
          </text>
        </box>
      </Show>
      <Show when={props.state().checkedAt}>
        <text fg={theme().text.muted} wrapMode="none" truncate>
          {label("Checked ", "Проверено ") + new Date(props.state().checkedAt ?? 0).toLocaleTimeString().slice(0, 5)}
        </text>
      </Show>
      </Show>
    </box>
  )
}

export default Plugin.define({
  id: "opencode.zen-models",
  setup(context) {
    // Network and model tools start folded: their title row keeps the status that matters.
    const [fold, updateFold] = context.storage.store("fold", { initial: { open: false } })
    const toggleFold = () =>
      void updateFold((draft) => {
        draft.open = !draft.open
      }).catch((error: unknown) => console.error("Failed to persist sidebar fold state", error))
    const [state, update] = context.storage.memory<CheckState>("checks", { initial: INITIAL })
    const [autoFallback, updateAutoFallback] = context.storage.store<{ enabled: boolean }>("autoFallback", {
      initial: { enabled: false },
    })
    const models = () => freeZenModels(context.data.location.model.list(context.location) ?? [])

    const toggleAutoFallback = async () => {
      try {
        const enabled = !autoFallback.enabled
        await updateAutoFallback((draft) => {
          draft.enabled = enabled
        })
        context.ui.toast.show({
          title: enabled
            ? text(context, "Auto Fallback enabled", "Автооткат моделей включён")
            : text(context, "Auto Fallback disabled", "Автооткат моделей выключен"),
          message: enabled
            ? text(
                context,
                "Orchestra will switch to another free model when rate limits are hit.",
                "Orchestra будет переключаться на другую бесплатную модель при лимитах.",
              )
            : text(
                context,
                "Orchestra keeps the current model on rate limits without switching.",
                "Orchestra сохраняет текущую модель при лимитах без переключения.",
              ),
          variant: "info",
        })
      } catch (cause) {
        context.ui.toast.show({
          title: text(context, "Could not save Auto Fallback setting", "Не удалось сохранить настройку автоотката"),
          message: cause instanceof Error ? cause.message : String(cause),
          variant: "error",
        })
      }
    }

    // Runs only when asked: every check is one request per model through the server, so it follows
    // the same route as chat (direct, WARP or a proxy) and spends the same allowance.
    async function refresh() {
      if (state.running) return
      update((draft) => { draft.running = true })
      await context.data.location.model.sync(context.location).catch(() => undefined)
      const queue = [...models()]
      update((draft) => {
        draft.checks = Object.fromEntries(queue.map((model) => [model.modelID, { state: "checking" as const }]))
      })
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
        for (let model = queue.shift(); model; model = queue.shift()) {
          const started = performance.now()
          const result = await context.client.generate
            .text({ prompt: PROMPT, model: { providerID: ZEN_PROVIDER_ID, id: model.modelID } })
            .then((): ZenModelCheck => ({ state: "ok", latencyMs: Math.round(performance.now() - started) }))
            .catch((cause: unknown) => classifyFailure(cause instanceof Error ? cause.message : String(cause)))
          const id = model.modelID
          update((draft) => { draft.checks[id] = result })
        }
      }))
      update((draft) => {
        draft.running = false
        draft.checkedAt = Date.now()
      })
    }

    context.ui.slot({
      append: "sidebar.content",
      render: () => (
        <Panel
          context={context}
          state={() => state}
          models={models}
          refresh={() => void refresh()}
          autoFallbackEnabled={autoFallback.enabled}
          toggleAutoFallback={() => void toggleAutoFallback()}
          expanded={fold.open}
          toggleExpanded={toggleFold}
        />
      ),
    })
  },
})
