import { createHoverFeedback } from "../ui/hover-feedback"
import { tint } from "../theme/color"
import { createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { CredentialVault } from "@orchestra/core/credential-vault/index"
import { HoverAction } from "./hover-action"
import { useTheme } from "../context/theme"
import { Keymap } from "../context/keymap"

/** Operator-only local registry UI. No model tool exposes this collector. */
export function RegistryVault(props: { projectID?:string; sessionID?:string; access?: Pick<ReturnType<typeof CredentialVault.local>,"list"|"writeFromOperator"|"deleteFromOperator"> & Partial<Pick<ReturnType<typeof CredentialVault.local>,"bindFromOperator"|"slots"|"setAllowedSessionsFromOperator">> }) {
  const theme = useTheme().surface("dialog")
  const cancelHover = createHoverFeedback()
  const vault = props.access ?? CredentialVault.local(props.projectID)
  const [entries, setEntries] = createSignal<Array<{ id: string; name: string; scope?:string; state?:string; allowedSessionIDs?:string[] }>>([])
  const [scope, setScope] = createSignal<CredentialVault.ScopeKind>(props.projectID ? "project" : "global")
  const [message, setMessage] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [addHovered, setAddHovered] = createSignal(false)
  const [armed, setArmed] = createSignal<string>()
  const [cursor, setCursor] = createSignal(0)
  let pending: AbortController | undefined
  onCleanup(() => pending?.abort())
  const cancel = () => { pending?.abort(); setMessage("Ввод отменён. Запись не сохранена.") }
  const refresh = async () => setEntries(vault.slots ? await vault.slots() : await vault.list())
  onMount(() => { void refresh().catch(() => setMessage("Реестр Vault недоступен. Изменения заблокированы.")) })
  const write = async (id?: string) => {
    if (busy()) return
    const controller = new AbortController(); pending = controller
    setBusy(true); setArmed(); setMessage("Открываю окно Windows (до 30 с). Если скрыто: Alt+Tab. Esc отменить.")
    try {
      const saved = await vault.writeFromOperator(id, controller.signal, (status) => setMessage(status ? `Windows: окно ${status.visible ? "видимо" : "не видно"}, ${status.foreground ? "на переднем плане" : "не на переднем плане"}. Alt+Tab → Orchestra Vault; Esc отменить. SHOWN: ${status.handle} @ ${status.x},${status.y} ${status.width}×${status.height}.` : "Windows сообщила о показе окна. Если скрыто: Alt+Tab. Esc отменить; таймаут 120 с."), id ? undefined : { name: "", site: "", scope: scope() })
      if (saved) { await refresh(); setMessage(`Сохранено. Имена переменных: ${saved.variables.login}, ${saved.variables.password}. Запись можно привязать текущему проекту кнопкой, без повторного ввода секрета. HTTP-подстановка включается в Безопасности текущего чата; shell/env-подстановка отсутствует.`) }
      else setMessage(controller.signal.aborted ? "Ввод отменён. Запись не сохранена." : "")
    } catch (error) { setMessage(error instanceof Error && error.message === "Vault secure input timed out; no entry saved." ? "Время ожидания окна истекло (120 с). Запись не сохранена." : error instanceof Error && error.message === "Vault secure input window did not open; no entry saved." ? "Окно Windows не открылось за 30 с. Запись не сохранена." : "Окно Vault не открылось или ввод завершился ошибкой. Запись не сохранена; нужен Windows DPAPI.") }
    finally { if (pending === controller) pending = undefined; setBusy(false) }
  }
  const grantCurrent = async (entry: { id:string; allowedSessionIDs?:string[] }, enabled: boolean) => {
    if (busy() || !props.sessionID || !vault.setAllowedSessionsFromOperator) return
    if (enabled && armed() !== `grant:${entry.id}`) { setArmed(`grant:${entry.id}`); setMessage("Подтвердите доступ текущему чату вторым нажатием. Значение не раскрывается; HTTP OFF включается отдельно."); return }
    setBusy(true)
    try {
      const allowed = (entry.allowedSessionIDs ?? []).filter((id) => id !== props.sessionID)
      await vault.setAllowedSessionsFromOperator(entry.id, enabled ? [...allowed, props.sessionID] : allowed, true)
      await refresh(); setMessage(enabled ? "Текущий чат добавлен в список доступа. HTTP-переключатель и права инструментов остаются отдельными." : "Доступ текущего чата отозван.")
    } catch { setMessage("Доступ не изменён. Проверьте проект и запись.") }
    finally { setBusy(false); setArmed() }
  }
  const remove = async (id: string) => {
    if (busy()) return
    if (armed() !== id) { setArmed(id); return }
    setBusy(true)
    try { await vault.deleteFromOperator(id, true); await refresh(); setMessage("Запись удалена.") }
    catch { setMessage("Запись не удалена. Реестр недоступен.") }
    finally { setArmed(); setBusy(false) }
  }
  Keymap.createLayer(() => ({ mode: "modal", commands: [
    ...(busy() ? [{ bind: "escape", title: "Отменить ввод Vault", group: "Vault", run: cancel }] : []),
    { bind: "ctrl+g", title: "Новая глобальная запись", group: "Vault", run: () => { if (!busy()) setScope("global") } },
    ...(props.projectID ? [{ bind: "ctrl+l", title: "Новая локальная запись", group: "Vault", run: () => { if (!busy()) setScope("project") } }] : []),
    { bind: "ctrl+n", title: "Добавить запись Vault", group: "Vault", run: () => void write() },
    { bind: "up", title: "Предыдущая запись", group: "Vault", run: () => { setArmed(); setCursor((value) => Math.max(0, value - 1)) } },
    { bind: "down", title: "Следующая запись", group: "Vault", run: () => { setArmed(); setCursor((value) => Math.min(Math.max(0, entries().length - 1), value + 1)) } },
    { bind: "return", title: "Заменить запись Vault", group: "Vault", run: () => { const entry = entries()[cursor()]; if (entry) void write(entry.id) } },
    { bind: "ctrl+d", title: "Подтвердить удаление записи Vault", group: "Vault", run: () => { const entry = entries()[cursor()]; if (entry) void remove(entry.id) } },
  ] }))
  return <box flexDirection="column" gap={1}>
    <text fg={theme.text.muted} wrapMode="word">Windows DPAPI · ввод в отдельном окне · ИИ видит имена, не значения. API-ключ/токен вводите в маскированное поле Пароль. Процессы вашей учётной записи не изолированы.</text>
    <box flexDirection="row" gap={2}>
      <Show when={props.projectID}><box id="registry-vault.scope-project" onMouseUp={() => { if (!busy()) setScope("project") }}><text fg={theme.text.base}>{scope() === "project" ? "[●] Только проект" : "[ ] Только проект"}</text></box></Show>
      <box id="registry-vault.scope-global" onMouseUp={() => { if (!busy()) setScope("global") }}><text fg={theme.text.base}>{scope() === "global" ? "[●] Все проекты" : "[ ] Все проекты"}</text></box>
    </box>
    <text fg={theme.text.muted} wrapMode="word">Новая запись: {scope() === "global" ? "глобальная, видна в любом проекте" : "локальная, только текущий проект"}. Доступ чата выдаётся отдельно, значение ИИ не получает.</text>
    <box alignItems="flex-start">
      <box id="registry-vault.add" border borderStyle="rounded" borderColor={theme.text.action.primary.base}
        paddingLeft={1} paddingRight={1} flexShrink={0}
        backgroundColor={addHovered() && !busy() ? tint(theme.background.base, theme.text.base, 0.12) : theme.background.base}
        onMouseOver={() => setAddHovered(true)} onMouseOut={() => setAddHovered(false)}
        onMouseDown={(event) => event.stopPropagation()}
        onMouseUp={(event) => { event.stopPropagation(); if (!busy()) void write() }}>
        <text fg={theme.text.base} wrapMode="none">{busy() ? "Ожидание окна…" : "+ Добавить запись"}</text>
      </box>
    </box>
    <Show when={busy()}><box id="registry-vault.cancel" backgroundColor={cancelHover.background()} onMouseOver={cancelHover.onMouseOver} onMouseOut={cancelHover.onMouseOut} onMouseDown={(event) => event.stopPropagation()} onMouseUp={(event) => { event.stopPropagation(); cancel() }}><text fg={theme.text.action.primary.base}>[ Отмена (Esc) ]</text></box></Show>
    <Show when={entries().length === 0}><text fg={theme.text.muted}>Нет записей</text></Show>
    <For each={entries()}>{(entry, index) => <box flexDirection="row" gap={1}>
      <text fg={theme.text.base}>{`${cursor() === index() ? "› " : "  "}${entry.name} · ${entry.scope === "global" ? "все проекты" : entry.scope === "project" ? "проект" : "legacy"}${entry.state === "empty" ? " · пусто" : ""}`}</text>
      <box flexGrow={1} />
      <Show when={props.projectID&&vault.bindFromOperator&&(!entry.scope||entry.scope==="legacy")}><HoverAction disabled={busy()} onClick={()=>{setBusy(true);void vault.bindFromOperator!(entry.id,props.projectID!).then(()=>setMessage("Имя разрешено этому проекту. HTTP всё ещё OFF до стрелки в Безопасности текущего чата.")).catch(()=>setMessage("Привязка не сохранена: проверьте имя и проект.")).finally(()=>setBusy(false))}}><text fg={theme.text.muted}>Разрешить проекту</text></HoverAction></Show>
      <Show when={props.sessionID && vault.setAllowedSessionsFromOperator}><HoverAction id={`registry-vault.grant-${entry.id}`} disabled={busy()} onClick={() => void grantCurrent(entry, !entry.allowedSessionIDs?.includes(props.sessionID!))}><text fg={theme.text.action.primary.base}>{entry.allowedSessionIDs?.includes(props.sessionID!) ? "Отозвать чат" : armed() === `grant:${entry.id}` ? "Подтвердить чат?" : "Доступ чату"}</text></HoverAction></Show>
      <HoverAction disabled={busy()} onClick={() => void write(entry.id)}><text fg={theme.text.muted}>{entry.state === "empty" ? "Заполнить" : "Заменить"}</text></HoverAction>
      <HoverAction disabled={busy()} onClick={() => void remove(entry.id)}><text fg={theme.text.feedback.warning.base}>{armed() === entry.id ? "Подтвердить удаление?" : "Удалить"}</text></HoverAction>
    </box>}</For>
    <Show when={message()}><text fg={theme.text.muted} wrapMode="word">{message()}</text></Show>
    <text fg={theme.text.muted} wrapMode="word">Ctrl+G глобальная · Ctrl+L локальная. Пустая запись заполняется через Enter.</text>
    <text fg={theme.text.muted} wrapMode="word">Ctrl+N добавить · Enter заменить · Ctrl+D дважды удалить.</text>
  </box>
}
