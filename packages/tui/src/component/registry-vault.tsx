import { tint } from "../theme/color"
import { createSignal, For, onMount, Show } from "solid-js"
import { CredentialVault } from "@orchestra/core/credential-vault/index"
import { HoverAction } from "./hover-action"
import { useTheme } from "../context/theme"
import { Keymap } from "../context/keymap"

/** Operator-only local registry UI. No model tool exposes this collector. */
export function RegistryVault(props: { access?: ReturnType<typeof CredentialVault.local> }) {
  const theme = useTheme().surface("dialog")
  const vault = props.access ?? CredentialVault.local()
  const [entries, setEntries] = createSignal<Array<{ id: string; name: string }>>([])
  const [message, setMessage] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [addHovered, setAddHovered] = createSignal(false)
  const [armed, setArmed] = createSignal<string>()
  const [cursor, setCursor] = createSignal(0)
  const refresh = async () => setEntries(await vault.list())
  onMount(() => { void refresh().catch(() => setMessage("Реестр Vault недоступен. Изменения заблокированы.")) })
  const write = async (id?: string) => {
    if (busy()) return
    setBusy(true); setArmed(); setMessage("Открывается защищённое окно Windows…")
    try {
      const saved = await vault.writeFromOperator(id)
      if (saved) { await refresh(); setMessage(`Сохранено. Имена переменных: ${saved.variables.login}, ${saved.variables.password}. Подстановка ещё отключена.`) }
      else setMessage("")
    } catch { setMessage("Не сохранено. Нужен Windows DPAPI и локальный защищённый ввод. Другие ОС пока не поддерживаются; открытого хранения нет.") }
    finally { setBusy(false) }
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
    { bind: "ctrl+n", title: "Добавить запись Vault", group: "Vault", run: () => void write() },
    { bind: "up", title: "Предыдущая запись", group: "Vault", run: () => { setArmed(); setCursor((value) => Math.max(0, value - 1)) } },
    { bind: "down", title: "Следующая запись", group: "Vault", run: () => { setArmed(); setCursor((value) => Math.min(Math.max(0, entries().length - 1), value + 1)) } },
    { bind: "return", title: "Заменить запись Vault", group: "Vault", run: () => { const entry = entries()[cursor()]; if (entry) void write(entry.id) } },
    { bind: "ctrl+d", title: "Подтвердить удаление записи Vault", group: "Vault", run: () => { const entry = entries()[cursor()]; if (entry) void remove(entry.id) } },
  ] }))
  return <box flexDirection="column" gap={1}>
    <text fg={theme.text.muted} wrapMode="word">Windows DPAPI · ввод в отдельном окне · чтение ИИ отключено. Процессы вашей учётной записи не изолированы.</text>
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
    <Show when={entries().length === 0}><text fg={theme.text.muted}>Нет записей</text></Show>
    <For each={entries()}>{(entry, index) => <box flexDirection="row" gap={1}>
      <text fg={theme.text.base}>{`${cursor() === index() ? "› " : "  "}${entry.name}`}</text>
      <box flexGrow={1} />
      <HoverAction disabled={busy()} onClick={() => void write(entry.id)}><text fg={theme.text.muted}>Заменить</text></HoverAction>
      <HoverAction disabled={busy()} onClick={() => void remove(entry.id)}><text fg={theme.text.feedback.warning.base}>{armed() === entry.id ? "Подтвердить удаление?" : "Удалить"}</text></HoverAction>
    </box>}</For>
    <Show when={message()}><text fg={theme.text.muted} wrapMode="word">{message()}</text></Show>
    <text fg={theme.text.muted} wrapMode="word">Ctrl+N добавить · Enter заменить · Ctrl+D дважды удалить.</text>
  </box>
}
