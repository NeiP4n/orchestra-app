import { createEffect, createSignal, For, onMount, Show } from "solid-js"
import { HoverAction } from "./hover-action"
import { useTheme } from "../context/theme"
import { TextAttributes } from "@opentui/core"
import { selectionBackground } from "../ui/hover"

export interface ProjectTemplatesKeys {
  move: (delta: number) => void
  activate: () => void
}

/** Adapter must prepare/revalidate in the background. No authority comes from display or a digest.
 * Only confirmSave/confirmCreate may mutate, and only for the prepared operation they receive.
 * Labels, automatic new folder/name choice and partial-failure recovery belong to the adapter. */
export interface ProjectTemplatesAccess {
  list: () => Promise<readonly { id: string; name: string }[]>
  prepareSave: () => Promise<{ token: string; name: string; details: string }>
  confirmSave: (token: string) => Promise<void>
  prepareCreate: (templateID: string) => Promise<{ token: string; name: string; details: string }>
  confirmCreate: (token: string) => Promise<void>
}
export function ProjectTemplatesSimple(props: {
  access: ProjectTemplatesAccess
  canSave: boolean
  keys?: (keys: ProjectTemplatesKeys) => void
  scrollIntoView?: (id: string) => void
}) {
  const theme = useTheme().surface("dialog")
  const [templates, setTemplates] = createSignal<readonly { id: string; name: string }[]>([])
  const [cursor, setCursor] = createSignal("save")
  const [busy, setBusy] = createSignal(false)
  const [details, setDetails] = createSignal(false)
  const [message, setMessage] = createSignal("")
  const [prepared, setPrepared] = createSignal<{
    kind: "save" | "create"
    token: string
    name: string
    details: string
  }>()
  const run = async (action: () => Promise<void>) => {
    if (busy()) return
    setBusy(true)
    try {
      await action()
    } catch {
      setPrepared()
      setMessage("Не получилось завершить. Ничего не заменено. Попробуйте ещё раз.")
    } finally {
      setBusy(false)
    }
  }
  const refresh = async () => {
    setTemplates(await props.access.list())
  }
  onMount(() => {
    void run(refresh)
  })
  const prepare = (kind: "save" | "create", id?: string) =>
    run(async () => {
      setPrepared()
      setDetails(false)
      setMessage("")
      if (kind === "save" && !props.canSave) return
      const result = kind === "save" ? await props.access.prepareSave() : await props.access.prepareCreate(id!)
      setPrepared({ kind, ...result })
      setCursor("confirm")
    })
  const confirm = () =>
    run(async () => {
      const current = prepared()
      if (!current) return
      // Consume the pending operation before awaiting: double clicks cannot confirm the same token twice.
      setPrepared()
      try {
        if (current.kind === "save") await props.access.confirmSave(current.token)
        else await props.access.confirmCreate(current.token)
      } catch {
        // Keep this exact durable operation, never prepare a second project after partial commit.
        setPrepared(current)
        setMessage("Не удалось завершить. Повторите это же подтверждение: продолжим без создания второй копии.")
        return
      }
      setMessage(
        current.kind === "save"
          ? "Проект сохранён как шаблон. Чаты, данные и секреты не сохранены."
          : "Проект создан. Заполните пустой Vault и войдите в браузеры. Расписания на паузе.",
      )
      // The commit succeeded. A list-refresh failure must never offer duplicate creation.
      try {
        await refresh()
      } catch {
        setMessage(message() + " Список пока не обновился.")
      }
    })
  const actions = () => prepared()
    ? ["confirm", "cancel", "details"]
    : [...(props.canSave ? ["save"] : []), ...templates().map((row) => `create-${row.id}`)]
  const focused = () => actions().includes(cursor()) ? cursor() : actions()[0]
  const cancel = () => {
    setPrepared()
    setDetails(false)
    setCursor("save")
  }
  const activate = (id = focused()) => {
    if (busy() || !id) return
    setCursor(id)
    if (id === "confirm") void confirm()
    else if (id === "cancel") cancel()
    else if (id === "details") setDetails(!details())
    else if (!prepared() && id === "save") void prepare("save")
    else if (!prepared() && id.startsWith("create-")) void prepare("create", id.slice(7))
  }
  props.keys?.({
    move: (delta) => {
      if (busy()) return
      const ids = actions()
      if (!ids.length) return
      const index = Math.max(0, ids.indexOf(focused() ?? ""))
      setCursor(ids[Math.max(0, Math.min(ids.length - 1, index + delta))])
    },
    activate: () => activate(),
  })
  createEffect(() => {
    const id = focused()
    if (id) props.scrollIntoView?.(`project-templates.${id}`)
  })
  const Action = (action: { id: string; label: string; disabled?: boolean }) => (
    <HoverAction
      id={`project-templates.${action.id}`}
      disabled={busy() || action.disabled}
      paddingLeft={1}
      paddingRight={1}
      background={!action.disabled && focused() === action.id ? selectionBackground(theme) : theme.background.raised.base}
      onClick={() => activate(action.id)}
    >
      <text
        fg={action.disabled || busy() ? theme.text.muted : theme.text.base}
        attributes={!action.disabled && focused() === action.id ? TextAttributes.BOLD : undefined}
      >
        {focused() === action.id && !action.disabled ? "› " : "  "}[ {action.label} ]
      </text>
    </HoverAction>
  )
  return (
    <box flexDirection="column" gap={1} paddingTop={1} paddingBottom={1}>
      <box flexDirection="column">
        <text fg={theme.text.base} attributes={TextAttributes.BOLD}>Шаблоны проектов</text>
        <text fg={theme.text.muted} wrapMode="word">
          Настройки, правила, ссылки и расписания. Без чатов, данных и секретов.
        </text>
      </box>
      <box flexDirection="column">
        <Action id="save" label="Сохранить проект как шаблон" disabled={!props.canSave || !!prepared()} />
        <Show when={!props.canSave}>
          <text fg={theme.text.muted} paddingLeft={3}>Откройте проект, чтобы сохранить шаблон.</text>
        </Show>
      </box>
      <box flexDirection="column" gap={1}>
        <text fg={theme.text.base} attributes={TextAttributes.BOLD}>Сохранённые шаблоны · {templates().length}</text>
        <Show when={templates().length === 0}>
          <box flexDirection="column">
            <Action id="create-empty" label="Создать проект из шаблона" disabled />
            <text fg={theme.text.muted} paddingLeft={3} wrapMode="word">Шаблонов пока нет. Сохраните проект выше.</text>
          </box>
        </Show>
        <For each={templates()}>
          {(template) => (
            <box flexDirection="column">
              <text fg={theme.text.base} paddingLeft={3} wrapMode="word">{template.name}</text>
              <Action id={`create-${template.id}`} label="Создать проект из шаблона" disabled={!!prepared()} />
            </box>
          )}
        </For>
      </box>
      <Show when={prepared()}>
        {(current) => (
          <box flexDirection="column" gap={1} paddingTop={1}>
            <text fg={theme.text.base} attributes={TextAttributes.BOLD} wrapMode="word">
              {current().kind === "save" ? "Сохранить" : "Создать"} «{current().name}»?{" "}
              {current().kind === "save"
                ? "Только настройки, без чатов, данных и секретов."
                : "Vault будет пустым, браузеры без входа, расписания на паузе."}
            </text>
            <box flexDirection="row" gap={1} flexWrap="wrap">
              <Action id="confirm" label={current().kind === "save" ? "Сохранить" : "Создать"} />
              <Action id="cancel" label="Отмена" />
              <Action id="details" label={details() ? "Скрыть подробности" : "Подробнее"} />
            </box>
            <Show when={details()}>
              <text fg={theme.text.muted} wrapMode="word">{current().details}</text>
            </Show>
          </box>
        )}
      </Show>
      <Show when={busy()}>
        <text fg={theme.text.muted}>Подготовка…</text>
      </Show>
      <Show when={message()}>
        <text fg={theme.text.base} wrapMode="word">{message()}</text>
      </Show>
      <text fg={theme.text.muted}>↑↓ выбор · Enter действие</text>
    </box>
  )
}
