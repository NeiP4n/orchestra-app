import { createSignal, For, onMount, Show } from "solid-js"
import { ProjectTemplateFiles } from "@orchestra/core/project-template-files"
import { ProjectTemplateLibrary } from "@orchestra/core/project-template-library"
import { useTheme } from "../context/theme"
import { HoverAction } from "./hover-action"

type Preview = Awaited<ReturnType<typeof ProjectTemplateFiles.load>>
type Library = ReturnType<typeof ProjectTemplateLibrary.local>

/** Operator-only config library. Staging is not activation or live project materialization. */
export function RegistryTemplates(props: {
  version: string
  library?: Library
  readSource?: typeof ProjectTemplateFiles.load
}) {
  const theme = useTheme().surface("dialog"),
    library = props.library ?? ProjectTemplateLibrary.local()
  const [entries, setEntries] = createSignal<ProjectTemplateLibrary.Entry[]>([])
  const [source, setSource] = createSignal("")
  const [name, setName] = createSignal("")
  const [destination, setDestination] = createSignal("")
  const [stagingDirectory, setStagingDirectory] = createSignal("")
  const [selected, setSelected] = createSignal<string>()
  const [preview, setPreview] = createSignal<Preview>()
  const [reviewed, setReviewed] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const [message, setMessage] = createSignal("")
  const refresh = async () => {
    setEntries(await library.list())
  }
  const invalidate = () => {
    setReviewed(false)
    setMessage("")
  }
  const run = async (action: () => Promise<void>) => {
    if (busy()) return
    setBusy(true)
    setMessage("")
    try {
      await action()
    } catch {
      setReviewed(false)
      setMessage(
        "Операция не завершена. Проверьте папку, формат, совместимость и уникальное имя; пересмотрите текущий JSON. Существующие определения не заменены.",
      )
    } finally {
      setBusy(false)
    }
  }
  onMount(() => {
    void run(refresh)
  })
  const read = () =>
    run(async () => {
      setPreview()
      setSelected()
      invalidate()
      setPreview(await (props.readSource ?? ProjectTemplateFiles.load)(source()))
    })
  const choose = (value: string) =>
    run(async () => {
      setPreview()
      setSelected()
      invalidate()
      const valuePreview = await library.preview(value)
      setSelected(value)
      setName(value)
      setPreview(valuePreview)
    })
  const remember = () =>
    run(async () => {
      const current = preview()
      if (!current || !reviewed() || selected()) return
      await library.remember(source(), name(), current.digest)
      setSelected(name())
      await refresh()
      setReviewed(false)
      setMessage(
        "Конфигурация сохранена в локальную библиотеку. Для передачи нужна отдельная копия в выбранную папку. Ничего не запущено.",
      )
    })
  const stage = () =>
    run(async () => {
      const current = preview(),
        entry = selected(),
        target = stagingDirectory()
      if (!current || !entry || !reviewed() || !target) return
      const result = await library.stage(entry, target, name(), current.digest, props.version)
      setReviewed(false)
      setMessage(
        `Подготовлено в ${result.directory}. Это только staging: live-сессии, браузеры и Vault-записи ещё не созданы; расписания не запущены. Чеклист: ${result.checklist.localVaultSlots.length} пустых локальных Vault-слотов, ${result.checklist.globalVaultSlots.length} глобальных привязок, ${result.checklist.sessions.length} ролей/моделей, ${result.checklist.browsers.length} новых логинов, ${result.checklist.schedules.length} paused-расписаний; отдельно проверьте правила и интеграции.`,
      )
    })
  const exportFolder = () =>
    run(async () => {
      const current = preview(),
        entry = selected()
      if (!current || !entry || !reviewed()) return
      const result = await library.export(entry, destination(), name(), current.digest)
      setReviewed(false)
      setMessage(
        `Создана папка ${result.directory}. Внутри только template.json. Существующие папки не заменены. Передача другим людям не выполнена.`,
      )
    })
  const labels: Record<string, string> = {
    "registry-templates.source": "Источник: папка с template.json",
    "registry-templates.name": "Уникальное имя новой копии (без перезаписи)",
    "registry-templates.staging": "Локальная папка подготовки, выбранная оператором",
    "registry-templates.destination": "Папка назначения переносимой копии",
  }
  const field = (id: string, value: string, placeholder: string, update: (value: string) => void) => (
    <box flexDirection="column">
      <text fg={theme.text.muted}>{labels[id]}</text>
      <Show when={!busy()} fallback={<text fg={theme.text.muted}>{value || placeholder}</text>}>
        <input
          id={id}
          value={value}
          placeholder={placeholder}
          onInput={(value) => {
            if (busy()) return
            update(value)
            invalidate()
          }}
          textColor={theme.text.formfield.base}
          focusedTextColor={theme.text.formfield.focused}
          placeholderColor={theme.text.muted}
          focusedBackgroundColor={theme.background.formfield.focused}
        />
      </Show>
    </box>
  )
  return (
    <box flexDirection="column" gap={1}>
      <text fg={theme.text.base}>Шаблоны проектов · локальная библиотека конфигураций</text>
      <text fg={theme.text.muted} wrapMode="word">
        Без чатов, данных страниц, cookies, профилей, памяти, значений Vault и старых разрешений. Пока доступны
        просмотр, сохранение, копирование и staging. Создание live-проекта из шаблона ещё не подключено.
      </text>
      <For each={entries()}>
        {(entry) => (
          <HoverAction
            id={`registry-templates.entry-${entry.name}`}
            disabled={busy() || entry.state !== "ready"}
            onClick={() => void choose(entry.name)}
          >
            <text fg={theme.text.base}>
              {selected() === entry.name ? "› " : "  "}
              {entry.name} · {entry.state === "ready" ? entry.title : "невалидный шаблон"}
            </text>
          </HoverAction>
        )}
      </For>
      <Show when={entries().length === 0}>
        <text fg={theme.text.muted}>Библиотека пуста. Выберите папку с одним template.json.</text>
      </Show>
      {field("registry-templates.source", source(), "Абсолютная папка источника", (value) => {
        setSource(value)
        setPreview()
        setSelected()
      })}
      <HoverAction id="registry-templates.read" disabled={busy()} onClick={() => void read()}>
        <text fg={theme.text.action.primary.base}>Просмотреть папку</text>
      </HoverAction>
      {field("registry-templates.name", name(), "Уникальное имя копии: factory_v2", setName)}
      <Show when={preview()}>
        {(current) => (
          <box flexDirection="column" gap={1}>
            <text fg={theme.text.base} wrapMode="word">
              {current().bundle.name} · минимум Orchestra {current().bundle.minOrchestraVersion} · SHA256{" "}
              {current().digest}
            </text>
            <text fg={theme.text.muted} wrapMode="word">
              Sessions {current().counts.sessions}; browsers {current().counts.browsers}; links {current().counts.links}
              ; rules {current().counts.rules}; schedules {current().counts.schedules}; local Vault{" "}
              {current().counts.localVaultSlots}; global requirements {current().counts.globalRequirements}.
            </text>
            <For each={current().warnings}>
              {(warning) => (
                <text fg={theme.text.feedback.warning.base} wrapMode="word">
                  {warning}
                </text>
              )}
            </For>
            <text fg={theme.text.base} wrapMode="word">
              {current().text}
            </text>
            <HoverAction id="registry-templates.review" disabled={busy()} onClick={() => setReviewed(!reviewed())}>
              <text fg={theme.text.action.primary.base}>
                {reviewed() ? "[●]" : "[ ]"} Проверил точный JSON, ссылки, правила и инструкции
              </text>
            </HoverAction>
            <Show when={!selected()}>
              <HoverAction
                id="registry-templates.remember"
                disabled={busy() || !reviewed()}
                onClick={() => void remember()}
              >
                <text fg={theme.text.action.primary.base}>Сохранить в библиотеку (новая копия)</text>
              </HoverAction>
            </Show>
            <Show when={selected()}>
              <>
                {field(
                  "registry-templates.staging",
                  stagingDirectory(),
                  "Локальная папка подготовки (не путь удалённого сервера)",
                  setStagingDirectory,
                )}
                <HoverAction
                  id="registry-templates.stage"
                  disabled={busy() || !reviewed() || !stagingDirectory()}
                  onClick={() => void stage()}
                >
                  <text fg={theme.text.action.primary.base}>
                    Подготовить в указанной локальной папке (не запускать)
                  </text>
                </HoverAction>
              </>
              {field(
                "registry-templates.destination",
                destination(),
                "Абсолютная папка для экспортной копии",
                setDestination,
              )}
              <HoverAction
                id="registry-templates.export"
                disabled={busy() || !reviewed()}
                onClick={() => void exportFolder()}
              >
                <text fg={theme.text.action.primary.base}>Создать переносимую папку (не отправлять)</text>
              </HoverAction>
            </Show>
          </box>
        )}
      </Show>
      <Show when={message()}>
        <text id="registry-templates.message" fg={theme.text.muted} wrapMode="word">
          {message()}
        </text>
      </Show>
    </box>
  )
}
