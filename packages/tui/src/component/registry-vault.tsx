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
  const [armed, setArmed] = createSignal<string>()
  const [cursor, setCursor] = createSignal(0)
  const refresh = async () => setEntries(await vault.list())
  onMount(() => { void refresh().catch(() => setMessage("Реестр Vault недоступен. Изменения заблокированы.")) })
  const write = async (id?: string) => {
    if (busy()) return
    setBusy(true); setArmed(); setMessage("")
    try {
      const saved = await vault.writeFromOperator(id)
      if (saved) { await refresh(); setMessage(`Сохранено. Имена переменных: ${saved.variables.login}, ${saved.variables.password}. Подстановка ещё отключена.`) }
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
    <text fg={theme.text.muted} wrapMode="word">Vault: логин и пароль зашифрованы Windows DPAPI. Ввод только в отдельном окне, не в чате. Чтение моделью и подстановка в команды отключены.</text>
    <HoverAction disabled={busy()} onClick={() => void write()}><text fg={theme.text.action.primary.base}>+ Добавить запись</text></HoverAction>
    <Show when={entries().length === 0}><text fg={theme.text.muted}>Нет записей</text></Show>
    <For each={entries()}>{(entry, index) => <box flexDirection="row" gap={1}>
      <text fg={theme.text.base}>{`${cursor() === index() ? "› " : "  "}${entry.name}`}</text>
      <box flexGrow={1} />
      <HoverAction disabled={busy()} onClick={() => void write(entry.id)}><text fg={theme.text.muted}>Заменить</text></HoverAction>
      <HoverAction disabled={busy()} onClick={() => void remove(entry.id)}><text fg={theme.text.feedback.warning.base}>{armed() === entry.id ? "Подтвердить удаление?" : "Удалить"}</text></HoverAction>
    </box>}</For>
    <Show when={message()}><text fg={theme.text.muted} wrapMode="word">{message()}</text></Show>
    <text fg={theme.text.muted} wrapMode="word">ctrl+n добавить · enter заменить · ctrl+d дважды удалить. Процесс под вашей учётной записью всё ещё может получить доступ к DPAPI.</text>
  </box>
}
