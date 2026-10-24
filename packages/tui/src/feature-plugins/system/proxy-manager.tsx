import { useTerminalDimensions } from "@opentui/solid"
import { Plugin } from "@orchestra/plugin/tui"
import { For, Show, createSignal } from "solid-js"
import { checkHttpProxies, fetchHttpProxySource, PROXY_SOURCES, proxyUrl, type ProxyEntry } from "./proxy-manager-core"
import { hoverBackground } from "../../ui/hover"

type ProxySetting = { http?: string; https?: string; no_proxy?: string[] } | null
type RouteState = {
  enabled: boolean
  activeUrl?: string
  previousProxy?: ProxySetting
  hasPreviousProxy: boolean
  autoIP: boolean
  acceptedWarning: boolean
}
type SourceState = { name: string; count: number; error: string; loading?: boolean }
type PoolState = { entries: ProxyEntry[]; sources: SourceState[]; total: number; loading: boolean; scanning: boolean; pending: number; checked: number; error: string }

const INITIAL_POOL: PoolState = { entries: [], sources: [], total: 0, loading: false, scanning: false, pending: 0, checked: 0, error: "" }
const INITIAL_ROUTE: RouteState = { enabled: false, hasPreviousProxy: false, autoIP: false, acceptedWarning: false }
const REFRESH_MS = 30 * 60 * 1000
const ROTATION_COOLDOWN_MS = 30_000
const BYPASS = ["localhost", "127.0.0.1", "::1"]

function ru(context: Plugin.Context) {
  return context.ui.language() === "ru"
}
function text(context: Plugin.Context, en: string, russian: string) {
  return ru(context) ? russian : en
}
function describeError(value: unknown, depth = 0): string {
  if (typeof value === "string" || typeof value === "number") return String(value)
  if (!value || typeof value !== "object" || depth > 5) return ""
  const record = value as Record<string, unknown>
  return [record.type, record.code, record.message, record.status, record.body,
    describeError(record.response, depth + 1), describeError(record.error, depth + 1), describeError(record.cause, depth + 1)]
    .filter((part) => part !== undefined && part !== null).join(" ")
}
function isZenAddressCap(error: unknown) {
  return /freeusagelimiterror|free tier counts requests per ip address|daily allowance.*ip|per ip address.*daily/i.test(describeError(error))
}
async function readConfiguredProxy(context: Plugin.Context): Promise<ProxySetting | undefined> {
  try {
    const entries = await context.client.config.get()
    const found = entries.findLast((entry) => entry.type === "document" && entry.info.proxy !== undefined)
    if (!found || found.type !== "document") return null
    return found.info.proxy
  } catch {
    return undefined
  }
}
function configFor(url: string) {
  return { http: url, https: url, no_proxy: BYPASS }
}
function matches(current: ProxySetting | undefined, url: string) {
  return current?.http === url && current?.https === url
}

function Button(props: { context: Plugin.Context; id: string; label: string; run: () => void; disabled?: boolean; emphasized?: boolean }) {
  const [hovered, setHovered] = createSignal(false)
  const theme = () => props.context.theme
  const base = () => theme().text.action?.primary?.base ?? theme().text.base
  const hover = () => theme().text.action?.primary?.hovered ?? theme().increase(base(), 2)
  return (
    <box id={props.id} paddingLeft={1} paddingRight={1}
      backgroundColor={props.disabled ? undefined : hovered() ? hoverBackground(theme()) : undefined}
      onMouseOver={() => setHovered(!props.disabled)} onMouseOut={() => setHovered(false)}
      onMouseUp={(event) => { event.stopPropagation(); if (!props.disabled) props.run() }}>
      <text fg={props.disabled ? theme().text.muted : hovered() ? hover() : props.emphasized ? base() : theme().text.muted} wrapMode="none" truncate>
        {props.emphasized ? <b>{props.label}</b> : props.label}
      </text>
    </box>
  )
}

function ManagerDialog(props: {
  context: Plugin.Context
  pool: () => PoolState
  route: () => RouteState
  active: () => ProxyEntry | undefined
  entries: () => ProxyEntry[]
  refresh: () => void
  use: (entry: ProxyEntry) => void
  disable: () => void
  close: () => void
}) {
  const theme = () => props.context.theme
  const dimensions = useTerminalDimensions()
  const label = (en: string, ruText: string) => text(props.context, en, ruText)
  const [hovered, setHovered] = createSignal<string>()
  const listHeight = () => Math.max(3, Math.min(6, dimensions().height - 22))
  const sourcesSummary = () => props.pool().sources.map((source) =>
    source.name + " " + (source.loading ? "…" : source.count) + (source.error ? " !" : ""),
  ).join(" · ")
  const actionHover = () => theme().text.action?.primary?.hovered ?? theme().increase(theme().text.action?.primary?.base ?? theme().text.base, 2)
  return (
    <box width="100%" gap={1} paddingLeft={1} paddingRight={1}>
      <box flexDirection="row" justifyContent="space-between" gap={1}>
        <text fg={theme().text.base}><b>Proxy Manager</b></text>
        <text fg={props.pool().scanning ? theme().text.feedback.info.base : theme().text.muted} wrapMode="none">{props.pool().loading ? label("Downloading sources…", "Загрузка источников…") : props.pool().scanning ? label("Checking OpenCode live", "Проверка OpenCode в фоне") : label("OpenCode-compatible pool", "Пул для OpenCode")}</text>
      </box>
      <text fg={theme().text.muted} wrapMode="word">
        {label(props.pool().entries.filter((item) => item.status === "healthy").length + " OpenCode-ready · " + props.pool().checked + "/" + props.pool().total + " checked · " + props.pool().pending + " queued",
          "Готово для OpenCode: " + props.pool().entries.filter((item) => item.status === "healthy").length + " · проверено: " + props.pool().checked + "/" + props.pool().total + " · в очереди: " + props.pool().pending)}
      </text>
      <Show when={props.route().enabled && props.active()}>
        <text fg={theme().text.feedback.success.base} wrapMode="none" truncate>
          {label("Active: ", "Активный: ") + (props.active()?.host ?? "") + ":" + (props.active()?.port ?? "")}
        </text>
      </Show>
      <Show when={props.pool().error}><text fg={theme().text.feedback.error.base} wrapMode="word">{props.pool().error}</text></Show>
      <scrollbox
        maxHeight={listHeight()}
        contentOptions={{ minHeight: 0, gap: 0 }}
        scrollbarOptions={{ visible: true }}
      >
        <Show when={props.entries().length === 0}>
          <text fg={theme().text.muted} wrapMode="word">
            {label("No OpenCode-ready proxies yet. The live scan will add results here as soon as endpoints pass.", "Пока нет прокси для OpenCode. Проверенные адреса появятся здесь сразу по мере завершения фонового сканирования.")}
          </text>
        </Show>
        <For each={props.entries()}>
          {(entry, index) => {
            const selected = () => props.route().enabled && props.route().activeUrl === proxyUrl(entry)
            const rowHovered = () => hovered() === entry.id
            const checked = () => entry.status === "healthy"
            const stateLabel = () => checked()
              ? String(entry.latencyMs) + " ms"
              : entry.status === "dead"
                ? label("blocked / failed", "нет доступа")
                : label("checking OpenCode…", "проверка OpenCode…")
            const stateColor = () => checked()
              ? theme().text.feedback.success.base
              : entry.status === "dead"
                ? theme().text.feedback.error.base
                : theme().text.feedback.info.base
            return (
              <box flexDirection="row" alignItems="center" gap={1}
                backgroundColor={rowHovered() ? hoverBackground(theme()) : undefined}
                onMouseOver={() => setHovered(entry.id)} onMouseOut={() => setHovered(undefined)}
                onMouseUp={(event) => { event.stopPropagation(); if (checked()) props.use(entry) }}>
                <text fg={selected() ? theme().text.feedback.success.base : rowHovered() ? actionHover() : theme().text.muted} wrapMode="none">
                  {selected() ? "●" : String(index() + 1).padStart(2, " ")}
                </text>
                <box flexGrow={1} minWidth={0}>
                  <text fg={rowHovered() ? actionHover() : checked() ? theme().text.base : theme().text.muted} wrapMode="none" truncate>{entry.host + ":" + entry.port}</text>
                  <text fg={rowHovered() ? theme().text.base : theme().text.muted} wrapMode="none" truncate>{entry.source}</text>
                </box>
                <text fg={rowHovered() ? actionHover() : stateColor()} wrapMode="none">{stateLabel()}</text>
                <text fg={checked() ? (rowHovered() ? actionHover() : theme().text.action?.primary?.base ?? theme().text.base) : theme().text.muted} wrapMode="none">
                  {checked() ? label("[Use]", "[Выбрать]") : "…"}
                </text>
              </box>
            )
          }}
        </For>
      </scrollbox>
      <text fg={theme().text.muted} wrapMode="word">
        {label("Only proxies that reach opencode.ai/zen/v1/models over verified TLS are selectable. Public proxies are untrusted: don't send sensitive code, secrets, or credentials through them.",
          "Выбираются только прокси, реально открывающие opencode.ai/zen/v1/models с проверкой TLS. Публичные прокси недоверенные: не передавай через них секреты, ключи и чувствительный код.")}
      </text>
      <text fg={theme().text.muted} wrapMode="none" truncate>
        {label("Sources: ", "Источники: ") + sourcesSummary()}
      </text>
      <box flexDirection="row" flexWrap="wrap" gap={1}>
        <Button context={props.context} id="proxy.manager.refresh" label={label("Refresh sources", "Обновить источники")} run={props.refresh} disabled={props.pool().loading || props.pool().scanning} emphasized />
        <Show when={props.route().enabled}>
          <Button context={props.context} id="proxy.manager.disable" label={label("Disable / restore previous", "Отключить / восстановить")} run={props.disable} />
        </Show>
        <Button context={props.context} id="proxy.manager.close" label={label("Close", "Закрыть")} run={props.close} />
      </box>
    </box>
  )
}

function Sidebar(props: {
  context: Plugin.Context
  pool: () => PoolState
  route: () => RouteState
  active: () => ProxyEntry | undefined
  next: () => void
  toggleAutoIP: () => void
  open: () => void
}) {
  const theme = () => props.context.theme
  const label = (en: string, ruText: string) => text(props.context, en, ruText)
  const healthy = () => props.pool().entries.filter((item) => item.status === "healthy").toSorted((a, b) => (a.latencyMs ?? 999_999) - (b.latencyMs ?? 999_999))
  const active = () => props.active()
  return (
    <box gap={1}>
      <box flexDirection="row" justifyContent="space-between" gap={1} alignItems="center">
        <text fg={theme().text.base}><b>PROXY POOL</b></text>
        <text fg={props.route().enabled ? theme().text.feedback.success.base : theme().text.muted} wrapMode="none">
          {props.route().enabled ? "● ON" : "○ OFF"}
        </text>
      </box>
      <text fg={theme().text.muted} wrapMode="none" truncate>{healthy().length + " verified / " + props.pool().total}</text>
      <Show when={active()}>
        <text fg={theme().text.feedback.success.base} wrapMode="none" truncate>
          {(active()?.host ?? "") + ":" + (active()?.port ?? "") + " · " + (active()?.latencyMs ?? "—") + " ms"}
        </text>
      </Show>
      <Show when={props.pool().loading || props.pool().scanning}>
        <text fg={theme().text.feedback.info.base} wrapMode="none" truncate>
          {label("The scan runs in the background; you can use any verified result immediately.", "Сканирование работает в фоне — уже проверенные адреса можно выбирать сразу.")}
        </text>
      </Show>
      <Button context={props.context} id="proxy.sidebar.next"
        label={props.route().enabled ? label("↻ Next verified IP", "↻ Следующий проверенный IP") : label("↗ Use fastest proxy", "↗ Быстрый прокси")}
        run={props.next} disabled={healthy().length === 0} emphasized />
      <box flexDirection="row" flexWrap="wrap" gap={1}>
        <Button context={props.context} id="proxy.sidebar.manage" label={label("Manage ↗", "Управление ↗")} run={props.open} />
        <Button context={props.context} id="proxy.sidebar.auto-ip"
          label={label(props.route().autoIP ? "Auto IP: ON" : "Auto IP: OFF", props.route().autoIP ? "Авто-IP: ВКЛ" : "Авто-IP: ВЫКЛ")}
          run={props.toggleAutoIP} emphasized={props.route().autoIP} />
      </box>
    </box>
  )
}

export default Plugin.define({
  id: "opencode.proxy-manager",
  setup(context) {
    const [pool, updatePool] = context.storage.memory<PoolState>("pool", { initial: INITIAL_POOL })
    const [route, updateRoute] = context.storage.store<RouteState>("route", { initial: INITIAL_ROUTE })
    let scanRunning = false
    let lastRotation = 0

    const healthy = () => pool.entries.filter((item) => item.status === "healthy").toSorted((a, b) => (a.latencyMs ?? 999_999) - (b.latencyMs ?? 999_999))
    const active = () => pool.entries.find((item) => proxyUrl(item) === route.activeUrl)

    async function refreshSources() {
      if (scanRunning) return
      scanRunning = true

      const now = Date.now()
      const recentWindow = 5 * 60_000
      const entries = pool.entries.map((entry) => {
        if (entry.status === "healthy" && entry.checkedAt && now - entry.checkedAt < recentWindow) return entry
        return { ...entry, status: "unchecked" as const, latencyMs: undefined, checkedAt: undefined, detail: undefined }
      })
      const entryIndex = new Map<string, number>()
      const seen = new Set<string>()
      entries.forEach((entry, index) => {
        entryIndex.set(entry.id, index)
        seen.add(entry.id)
      })

      // Fresh verified results stay selectable while the other sources refresh.
      const queue: ProxyEntry[] = entries.filter((entry) => entry.status === "unchecked")
      let fetching = true
      let wake: (() => void) | undefined
      const signalWorker = () => {
        const resume = wake
        wake = undefined
        resume?.()
      }
      const waitForQueue = () => new Promise<void>((resolve) => {
        const resume = () => {
          clearTimeout(timer)
          if (wake === resume) wake = undefined
          resolve()
        }
        const timer = setTimeout(resume, 250)
        wake = resume
      })

      updatePool((draft) => {
        draft.entries = entries
        draft.sources = PROXY_SOURCES.map((source) => ({ name: source.name, count: 0, error: "", loading: true }))
        draft.total = entries.length
        draft.checked = entries.filter((entry) => entry.status === "healthy").length
        draft.pending = queue.length
        draft.loading = true
        draft.scanning = true
        draft.error = ""
      })

      const sources = PROXY_SOURCES.map(async (source, sourceIndex) => {
        const result = await fetchHttpProxySource(source)
        const additions: ProxyEntry[] = []
        for (const entry of result.entries) {
          if (seen.has(entry.id) || entryIndex.size >= 12_000) continue
          seen.add(entry.id)
          entryIndex.set(entry.id, entryIndex.size)
          additions.push(entry)
        }
        // The first address is published to the list before any other source has to finish downloading.
        updatePool((draft) => {
          draft.sources[sourceIndex] = { name: result.name, count: result.count, error: result.error, loading: false }
          if (additions.length) draft.entries.push(...additions)
          draft.total = entryIndex.size
          draft.pending = queue.length + additions.length
          if (result.error && draft.sources.every((item) => !item.loading && item.count === 0)) {
            draft.error = "All public proxy sources failed to load."
          }
        })
        if (additions.length) {
          queue.push(...additions)
          updatePool((draft) => { draft.pending = queue.length })
          signalWorker()
        }
      })

      const sourcesDone = Promise.all(sources).finally(() => {
        fetching = false
        updatePool((draft) => { draft.loading = false })
        signalWorker()
      })

      const worker = async () => {
        while (fetching || queue.length > 0) {
          if (queue.length === 0) {
            await waitForQueue()
            continue
          }
          const batch = queue.splice(0, 8)
          updatePool((draft) => { draft.pending = queue.length })
          await checkHttpProxies(batch, 8, (checked) => {
            const index = entryIndex.get(checked.id)
            updatePool((draft) => {
              if (index !== undefined && draft.entries[index]?.id === checked.id) {
                draft.entries[index] = checked
                draft.checked += 1
              }
              draft.pending = queue.length
            })
          })
        }
      }

      try {
        await Promise.all([sourcesDone, worker()])
        const accepted = pool.entries.filter((entry) => entry.status === "healthy").length
        context.ui.toast.show({
          title: text(context, "OpenCode proxy scan finished", "Проверка прокси для OpenCode завершена"),
          message: text(context, accepted + " proxies passed the Zen API endpoint check.", "Прокси, прошедших проверку Zen API: " + accepted + "."),
          variant: accepted > 0 ? "success" : "warning",
        })
      } catch (cause) {
        const reason = cause instanceof Error ? cause.message : String(cause)
        updatePool((draft) => { draft.error = reason })
        context.ui.toast.show({ title: text(context, "Proxy scan failed", "Ошибка проверки прокси"), message: reason, variant: "error" })
      } finally {
        scanRunning = false
        updatePool((draft) => { draft.loading = false; draft.scanning = false; draft.pending = 0 })
      }
    }

    async function useProxy(entry: ProxyEntry, automatic = false) {
      if (entry.status !== "healthy") return
      const url = proxyUrl(entry)
      const current = await readConfiguredProxy(context)
      if (current === undefined) {
        context.ui.toast.show({ title: text(context, "Could not read proxy configuration", "Не удалось прочитать настройки прокси"), variant: "error" })
        return
      }
      const owned = route.enabled && matches(current, route.activeUrl ?? "")
      if (automatic && route.enabled && !owned) {
        context.ui.toast.show({ title: text(context, "Proxy changed outside manager", "Прокси изменён вне менеджера"), message: text(context, "Auto IP left the newer setting untouched.", "Авто-IP не изменил новые настройки."), variant: "warning" })
        return
      }
      if (!automatic && !route.acceptedWarning) {
        const accepted = await context.ui.dialog.confirm({
          title: text(context, "Use a public proxy?", "Использовать публичный прокси?"),
          message: text(context, "These servers are operated by unknown parties and can observe connection metadata. HTTPS certificate validation remains enabled. Continue only if you accept this risk.",
            "Этими серверами управляют неизвестные операторы, которые видят метаданные соединений. Проверка сертификатов HTTPS остаётся включённой. Продолжай только если принимаешь этот риск."),
          label: { confirm: text(context, "I understand", "Понимаю"), cancel: text(context, "Cancel", "Отмена") },
        })
        if (!accepted) return
        updateRoute((draft) => { draft.acceptedWarning = true })
      }
      if (!automatic && !owned && current && (current.http || current.https)) {
        const accepted = await context.ui.dialog.confirm({
          title: text(context, "Replace the current proxy?", "Заменить текущий прокси?"),
          message: text(context, "OpenCode already has a proxy configured (possibly WARP). It will be saved and restored when the pool is disabled.",
            "В OpenCode уже настроен прокси (возможно, WARP). Он будет сохранён и восстановлен при отключении пула."),
          label: { confirm: text(context, "Replace", "Заменить"), cancel: text(context, "Cancel", "Отмена") },
        })
        if (!accepted) return
      }
      try {
        if (!owned) updateRoute((draft) => { draft.previousProxy = current; draft.hasPreviousProxy = true })
        await context.client.config.update({ proxy: configFor(url) })
        updateRoute((draft) => { draft.enabled = true; draft.activeUrl = url })
        context.ui.toast.show({
          title: automatic ? text(context, "Auto IP switched proxy", "Авто-IP сменил прокси") : text(context, "Proxy activated", "Прокси включён"),
          message: automatic
            ? text(context, "Zen's daily IP cap was detected. Retry the failed request manually; it is not replayed automatically.", "Обнаружен дневной IP-лимит Zen. Повтори неудачный запрос вручную: автоматического повтора нет.")
            : text(context, "OpenCode now uses " + entry.host + ":" + entry.port + ".", "OpenCode теперь использует " + entry.host + ":" + entry.port + "."),
          variant: "success",
        })
      } catch (cause) {
        context.ui.toast.show({ title: text(context, "Could not activate proxy", "Не удалось включить прокси"), message: cause instanceof Error ? cause.message : String(cause), variant: "error" })
      }
    }

    async function disableProxy() {
      if (!route.enabled || !route.activeUrl) return
      const current = await readConfiguredProxy(context)
      if (current === undefined) {
        context.ui.toast.show({ title: text(context, "Could not read proxy configuration", "Не удалось прочитать настройки прокси"), variant: "error" })
        return
      }
      if (!matches(current, route.activeUrl)) {
        updateRoute((draft) => { draft.enabled = false; draft.activeUrl = undefined; draft.previousProxy = undefined; draft.hasPreviousProxy = false })
        context.ui.toast.show({ title: text(context, "Proxy changed elsewhere", "Прокси изменён извне"), message: text(context, "Left the newer setting untouched.", "Новые настройки оставлены без изменений."), variant: "warning" })
        return
      }
      try {
        await context.client.config.update({ proxy: route.hasPreviousProxy ? route.previousProxy ?? null : null })
        updateRoute((draft) => { draft.enabled = false; draft.activeUrl = undefined; draft.previousProxy = undefined; draft.hasPreviousProxy = false })
        context.ui.toast.show({ title: text(context, "Proxy pool disabled", "Proxy Pool отключён"), message: text(context, "Previous proxy configuration restored.", "Предыдущие настройки прокси восстановлены."), variant: "success" })
      } catch (cause) {
        context.ui.toast.show({ title: text(context, "Could not restore proxy", "Не удалось восстановить прокси"), message: cause instanceof Error ? cause.message : String(cause), variant: "error" })
      }
    }

    async function nextProxy(automatic = false) {
      const entry = healthy().find((candidate) => proxyUrl(candidate) !== route.activeUrl)
      if (!entry) {
        context.ui.toast.show({ title: text(context, "No other verified proxy", "Нет другого проверенного прокси"), message: text(context, "Check more endpoints or update sources.", "Проверь ещё адреса или обнови источники."), variant: "warning" })
        return
      }
      await useProxy(entry, automatic)
    }

    const toggleAutoIP = () => {
      const enabled = !route.autoIP
      updateRoute((draft) => { draft.autoIP = enabled })
      context.ui.toast.show({
        title: enabled ? text(context, "Auto IP enabled", "Авто-IP включён") : text(context, "Auto IP disabled", "Авто-IP отключён"),
        message: enabled
          ? text(context, "When Zen's daily per-IP cap is detected, the next verified proxy is selected. Enable Proxy Pool first.", "При обнаружении дневного IP-лимита Zen будет выбран следующий проверенный прокси. Сначала включи Proxy Pool.")
          : text(context, "The active proxy will stay selected.", "Активный прокси останется выбранным."),
        variant: "info",
      })
    }

    const open = () => {
      context.ui.dialog.show(() => (
        <ManagerDialog context={context} pool={() => pool} route={() => route} active={active}
          entries={() => [
            ...healthy().slice(0, 24),
            ...pool.entries.filter((entry) => entry.status === "unchecked").slice(0, 24),
          ]}
          refresh={() => void refreshSources()}
          use={(entry) => void useProxy(entry)} disable={() => void disableProxy()} close={() => context.ui.dialog.clear()} />
      ))
      context.ui.dialog.set({ size: "medium", centered: true })
    }

    context.ui.slot({
      append: "app",
      render() {
        context.keymap.layer(() => ({
          mode: "global",
          commands: [{
            id: "opencode.proxy-manager.open",
            title: text(context, "Public Proxy Manager", "Менеджер публичных прокси"),
            description: text(context, "Browse verified public HTTP proxies for OpenCode", "Выбор проверенных публичных HTTP-прокси для OpenCode"),
            group: "Network",
            slash: { name: "proxy-manager" },
            palette: true,
            run: open,
          }],
        }))
        return null
      },
    })
    context.ui.slot({
      append: "sidebar.content",
      render: () => <Sidebar context={context} pool={() => pool} route={() => route} active={active}
        next={() => void (route.enabled ? nextProxy() : healthy()[0] && useProxy(healthy()[0]))}
        toggleAutoIP={toggleAutoIP} open={open} />,
    })

    const disposeFailure = context.data.on("session.execution.failed", (event) => {
      if (!route.enabled || !route.autoIP || !isZenAddressCap(event.data.error)) return
      if (Date.now() - lastRotation < ROTATION_COOLDOWN_MS) return
      lastRotation = Date.now()
      void nextProxy(true)
    })
    const startup = setTimeout(() => void refreshSources(), 200)
    const timer = setInterval(() => void refreshSources(), REFRESH_MS)
    return () => {
      clearTimeout(startup)
      clearInterval(timer)
      disposeFailure()
    }
  },
})
