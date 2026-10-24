import { Plugin } from "@orchestra/plugin/tui"
import { For, Show, createSignal } from "solid-js"
import { checkHttpProxies, loadHttpProxyPool, proxyUrl, type ProxyEntry } from "./proxy-manager-core"

type ProxySetting = { http?: string; https?: string; no_proxy?: string[] } | null
type RouteState = {
  enabled: boolean
  activeUrl?: string
  previousProxy?: ProxySetting
  hasPreviousProxy: boolean
  autoIP: boolean
  acceptedWarning: boolean
}
type SourceState = { name: string; count: number; error: string }
type PoolState = { entries: ProxyEntry[]; sources: SourceState[]; total: number; loading: boolean; checked: number; error: string }

const INITIAL_POOL: PoolState = { entries: [], sources: [], total: 0, loading: false, checked: 0, error: "" }
const INITIAL_ROUTE: RouteState = { enabled: false, hasPreviousProxy: false, autoIP: false, acceptedWarning: false }
const BATCH = 48
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
      backgroundColor={props.disabled ? undefined : hovered() ? (theme().background.raised?.base ?? theme().background.base) : undefined}
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
  checkMore: () => void
  use: (entry: ProxyEntry) => void
  disable: () => void
  close: () => void
}) {
  const theme = () => props.context.theme
  const label = (en: string, ruText: string) => text(props.context, en, ruText)
  const [hovered, setHovered] = createSignal<string>()
  return (
    <box width="100%" gap={1} paddingLeft={1} paddingRight={1}>
      <box flexDirection="row" justifyContent="space-between" gap={1}>
        <text fg={theme().text.base}><b>Proxy Manager</b></text>
        <text fg={theme().text.muted} wrapMode="none">{props.pool().loading ? label("Updating…", "Обновление…") : label("Public HTTP pool", "Публичный HTTP-пул")}</text>
      </box>
      <text fg={theme().text.muted} wrapMode="word">
        {label(props.pool().entries.filter((item) => item.status === "healthy").length + " verified · " + props.pool().total + " unique · " + props.pool().checked + " checked",
          "Проверено: " + props.pool().entries.filter((item) => item.status === "healthy").length + " · найдено: " + props.pool().total + " · тестов: " + props.pool().checked)}
      </text>
      <Show when={props.route().enabled && props.active()}>
        <text fg={theme().text.feedback.success.base} wrapMode="none" truncate>
          {label("Active: ", "Активный: ") + (props.active()?.host ?? "") + ":" + (props.active()?.port ?? "")}
        </text>
      </Show>
      <Show when={props.pool().error}><text fg={theme().text.feedback.error.base} wrapMode="word">{props.pool().error}</text></Show>
      <For each={props.entries()}>
        {(entry, index) => {
          const selected = () => props.route().enabled && props.route().activeUrl === proxyUrl(entry)
          return (
            <box flexDirection="row" alignItems="center" gap={1}
              backgroundColor={hovered() === entry.id ? (theme().background.raised?.base ?? theme().background.base) : undefined}
              onMouseOver={() => setHovered(entry.id)} onMouseOut={() => setHovered(undefined)}
              onMouseUp={(event) => { event.stopPropagation(); props.use(entry) }}>
              <text fg={selected() ? theme().text.feedback.success.base : theme().text.muted} wrapMode="none">
                {selected() ? "●" : String(index() + 1).padStart(2, " ")}
              </text>
              <box flexGrow={1} minWidth={0}>
                <text fg={theme().text.base} wrapMode="none" truncate>{entry.host + ":" + entry.port}</text>
                <text fg={theme().text.muted} wrapMode="none" truncate>{entry.source}</text>
              </box>
              <text fg={theme().text.feedback.success.base} wrapMode="none">{entry.latencyMs + " ms"}</text>
              <text fg={theme().text.action?.primary?.base ?? theme().text.base} wrapMode="none">{label("[Use]", "[Выбрать]")}</text>
            </box>
          )
        }}
      </For>
      <Show when={props.entries().length === 0}>
        <text fg={theme().text.muted} wrapMode="word">
          {label("No verified proxies yet. Update sources and let the health checks finish.", "Пока нет проверенных прокси. Обнови источники и дождись завершения проверки.")}
        </text>
      </Show>
      <text fg={theme().text.muted} wrapMode="word">
        {label("Public proxies are operated by unknown parties. Selection requires HTTP CONNECT and verified HTTPS TLS. Do not disable certificate validation.",
          "Публичными прокси управляют неизвестные операторы. Выбор требует HTTP CONNECT и успешной проверки HTTPS/TLS. Не отключай проверку сертификатов.")}
      </text>
      <For each={props.pool().sources}>
        {(source) => <text fg={source.error ? theme().text.feedback.warning.base : theme().text.muted} wrapMode="none" truncate>
          {source.name + ": " + source.count + (source.error ? " · " + source.error : "")}
        </text>}
      </For>
      <box flexDirection="row" flexWrap="wrap" gap={1}>
        <Button context={props.context} id="proxy.manager.refresh" label={label("Update sources", "Обновить источники")} run={props.refresh} disabled={props.pool().loading} emphasized />
        <Button context={props.context} id="proxy.manager.check-more" label={label("Check next 48", "Проверить следующие 48")} run={props.checkMore} disabled={props.pool().loading} />
        <Show when={props.route().enabled}>
          <Button context={props.context} id="proxy.manager.disable" label={label("Disable / restore previous", "Отключить / восстановить")} run={props.disable} disabled={props.pool().loading} />
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
      <Show when={props.pool().loading}>
        <text fg={theme().text.feedback.info.base} wrapMode="none" truncate>{label("Loading/checking…", "Загрузка/проверка…")}</text>
      </Show>
      <Button context={props.context} id="proxy.sidebar.next"
        label={props.route().enabled ? label("↻ Next verified IP", "↻ Следующий проверенный IP") : label("↗ Use fastest proxy", "↗ Быстрый прокси")}
        run={props.next} disabled={props.pool().loading || healthy().length === 0} emphasized />
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
    let busy = false
    let lastRotation = 0

    const healthy = () => pool.entries.filter((item) => item.status === "healthy").toSorted((a, b) => (a.latencyMs ?? 999_999) - (b.latencyMs ?? 999_999))
    const active = () => pool.entries.find((item) => proxyUrl(item) === route.activeUrl)

    async function testBatch(batch: ProxyEntry[]) {
      const checked = await checkHttpProxies(batch, 12)
      const byId = new Map(checked.map((entry) => [entry.id, entry]))
      updatePool((draft) => {
        draft.entries = draft.entries.map((entry) => byId.get(entry.id) ?? entry)
        draft.checked = draft.entries.filter((entry) => entry.status !== "unchecked").length
      })
    }

    async function refreshSources() {
      if (busy) return
      busy = true
      updatePool((draft) => { draft.loading = true; draft.error = "" })
      try {
        const old = new Map(pool.entries.map((entry) => [entry.id, entry]))
        const result = await loadHttpProxyPool()
        const now = Date.now()
        const entries = result.entries.map((entry) => {
          const previous = old.get(entry.id)
          return previous?.status === "healthy" && previous.checkedAt && now - previous.checkedAt < 15 * 60_000
            ? { ...previous, source: entry.source }
            : entry
        })
        updatePool((draft) => {
          draft.entries = entries
          draft.sources = result.sources
          draft.total = result.total
          draft.checked = entries.filter((entry) => entry.status !== "unchecked").length
          draft.error = result.total ? "" : "Public sources returned no valid HTTP proxies or are unreachable."
        })
        const batch = entries.filter((entry) => entry.status === "unchecked").slice(0, BATCH)
        await testBatch(batch)
        context.ui.toast.show({
          title: text(context, "Proxy sources updated", "Источники прокси обновлены"),
          message: text(context, "Loaded " + result.total + " unique endpoints; checking " + batch.length + ".", "Загружено уникальных адресов: " + result.total + "; проверка партии: " + batch.length + "."),
          variant: result.total ? "success" : "warning",
        })
      } catch (cause) {
        const reason = cause instanceof Error ? cause.message : String(cause)
        updatePool((draft) => { draft.error = reason })
        context.ui.toast.show({ title: text(context, "Proxy update failed", "Не удалось обновить прокси"), message: reason, variant: "error" })
      } finally {
        busy = false
        updatePool((draft) => { draft.loading = false; draft.checked = draft.entries.filter((entry) => entry.status !== "unchecked").length })
      }
    }

    async function checkMore() {
      if (busy) return
      const batch = pool.entries.filter((entry) => entry.status === "unchecked").slice(0, BATCH)
      if (!batch.length) {
        context.ui.toast.show({ title: text(context, "No unchecked proxies left", "Нет непроверенных прокси"), message: text(context, "Update the sources for new endpoints.", "Обнови источники для новых адресов."), variant: "info" })
        return
      }
      busy = true
      updatePool((draft) => { draft.loading = true })
      try {
        await testBatch(batch)
        context.ui.toast.show({ title: text(context, "Proxy check completed", "Проверка завершена"), message: text(context, "Checked " + batch.length + " more endpoints.", "Проверено ещё адресов: " + batch.length + "."), variant: "success" })
      } catch (cause) {
        context.ui.toast.show({ title: text(context, "Proxy check failed", "Ошибка проверки"), message: cause instanceof Error ? cause.message : String(cause), variant: "error" })
      } finally {
        busy = false
        updatePool((draft) => { draft.loading = false })
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
          entries={() => healthy().slice(0, 12)} refresh={() => void refreshSources()} checkMore={() => void checkMore()}
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
