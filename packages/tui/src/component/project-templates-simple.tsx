import { createSignal, For, onMount, Show } from "solid-js"
import { HoverAction } from "./hover-action"
import { useTheme } from "../context/theme"

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
export function ProjectTemplatesSimple(props: { access: ProjectTemplatesAccess; canSave: boolean }) {
  const theme = useTheme().surface("dialog")
  const [templates, setTemplates] = createSignal<readonly { id: string; name: string }[]>([])
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
  return (
    <box flexDirection="column" gap={1}>
      <text fg={theme.text.base}>Шаблоны проектов</text>
      <text fg={theme.text.muted} wrapMode="word">
        Сохраняются настройки, правила, ссылки и расписания. Чаты, данные и секреты не переносятся.
      </text>
      <HoverAction id="project-templates.save" disabled={busy() || !props.canSave} onClick={() => void prepare("save")}>
        <text fg={props.canSave ? theme.text.action.primary.base : theme.text.muted}>Сохранить проект как шаблон</text>
      </HoverAction>
      <Show when={!props.canSave}>
        <text fg={theme.text.muted}>Для сохранения откройте проект.</text>
      </Show>
      <text fg={theme.text.base}>Создать проект из шаблона</text>
      <Show when={templates().length === 0}>
        <text fg={theme.text.muted}>Сохранённых шаблонов пока нет.</text>
      </Show>
      <For each={templates()}>
        {(template) => (
          <HoverAction
            id={`project-templates.create-${template.id}`}
            disabled={busy()}
            onClick={() => void prepare("create", template.id)}
          >
            <text fg={theme.text.action.primary.base}>{template.name}</text>
          </HoverAction>
        )}
      </For>
      <Show when={prepared()}>
        {(current) => (
          <box flexDirection="column" gap={1}>
            <text fg={theme.text.base} wrapMode="word">
              {current().kind === "save" ? "Сохранить" : "Создать"} «{current().name}»?{" "}
              {current().kind === "save"
                ? "Только настройки, без чатов, данных и секретов."
                : "Vault будет пустым, браузеры без входа, расписания на паузе."}
            </text>
            <box flexDirection="row" gap={3}>
              <HoverAction id="project-templates.confirm" disabled={busy()} onClick={() => void confirm()}>
                <text fg={theme.text.action.primary.base}>{current().kind === "save" ? "Сохранить" : "Создать"}</text>
              </HoverAction>
              <HoverAction
                id="project-templates.cancel"
                disabled={busy()}
                onClick={() => {
                  setPrepared()
                  setDetails(false)
                }}
              >
                <text fg={theme.text.muted}>Отмена</text>
              </HoverAction>
              <HoverAction id="project-templates.details" disabled={busy()} onClick={() => setDetails(!details())}>
                <text fg={theme.text.muted}>{details() ? "Скрыть подробности" : "Подробнее"}</text>
              </HoverAction>
            </box>
            <Show when={details()}>
              <text fg={theme.text.muted} wrapMode="word">
                {current().details}
              </text>
            </Show>
          </box>
        )}
      </Show>
      <Show when={busy()}>
        <text fg={theme.text.muted}>Подготовка…</text>
      </Show>
      <Show when={message()}>
        <text fg={theme.text.muted} wrapMode="word">
          {message()}
        </text>
      </Show>
    </box>
  )
}
