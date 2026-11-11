import { createMemo, createSignal, For, Show } from "solid-js"
import { useLayout } from "@/shell/state/layout"
import { ServerConnection } from "@/runtime/server/registry"
import { useGlobal, useServerCtx } from "@/runtime/server/runtime"

type Entry = { id: string; name: string }

export interface TemplateFileAccess {
  list: () => Promise<readonly Entry[]>
  projects: () => Promise<readonly Entry[]>
  exportFile: (templateID: string, projectID: string) => Promise<{ path: string; warning: string }>
  prepareImport: (path: string) => Promise<{ token: string; name: string; details: string; unresolvedRoles?: readonly string[] }>
  confirmImport: (token: string) => Promise<Entry>
}

export function TemplateFiles(props: { access: TemplateFileAccess }) {
  const [entries, setEntries] = createSignal<readonly Entry[]>([])
  const [projects, setProjects] = createSignal<readonly Entry[]>([])
  const [project, setProject] = createSignal("")
  const [file, setFile] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [status, setStatus] = createSignal("")
  const [loaded, setLoaded] = createSignal(false)
  const [pending, setPending] = createSignal<Awaited<ReturnType<TemplateFileAccess["prepareImport"]>>>()

  const run = async (action: () => Promise<void>) => {
    if (busy()) return
    setBusy(true)
    setStatus("")

    try { await action() } catch { setStatus("Не удалось завершить. Проверьте файл и подключение. Повторить можно той же кнопкой.") }
    finally { setBusy(false) }
  }

  const load = () => run(async () => {
    const [templates, destinations] = await Promise.all([props.access.list(), props.access.projects()])
    setEntries(templates)
    setProjects(destinations)

    if (!destinations.some(row => row.id === project())) setProject(destinations[0]?.id ?? "")
    setLoaded(true)
  })

  return (
    <details data-slot="template-files" class="max-h-[75vh] overflow-y-auto border-b border-v2-border-border-base px-3 py-2 text-xs">
      <summary class="cursor-pointer" onClick={() => { if (!loaded()) void load() }}>Шаблоны: экспорт / импорт файла</summary>
      <div class="flex flex-col gap-3 py-3" aria-busy={busy()}>
        <p>Экспорт сохраняется в корне выбранного проекта на сервере. Не добавляйте .orchestra-template в git. Чаты и значения секретов не копируются.</p>
        <button class="rounded border border-v2-border-border-base px-3 py-2 text-start hover:bg-v2-surface-surface-raised focus-visible:outline focus-visible:outline-2 disabled:opacity-50" type="button" disabled={busy()} onClick={() => void load()}>Обновить список</button>
        <Show when={!loaded()}><p role="status">Загрузка библиотеки...</p></Show>
        <Show when={loaded() && entries().length === 0}><p>Шаблонов пока нет. Сохраните проект как шаблон в Реестре.</p></Show>
        <label class="flex flex-col gap-1">Папка проекта для экспорта
          <select class="rounded border border-v2-border-border-base bg-v2-background-bg-base px-3 py-2" aria-label="Проект для экспорта" value={project()} onChange={e => setProject(e.currentTarget.value)} disabled={busy()}>
            <For each={projects()}>{row => <option value={row.id}>{row.name}</option>}</For>
          </select>
        </label>
        <For each={entries()}>{entry => <div class="flex flex-wrap items-center gap-2">
          <span>{entry.name}</span>
          <button class="rounded border border-v2-border-border-base px-3 py-2 text-start hover:bg-v2-surface-surface-raised focus-visible:outline focus-visible:outline-2 disabled:opacity-50" type="button" disabled={busy() || !project()} onClick={() => void run(async () => {
            const result = await props.access.exportFile(entry.id, project())
            setStatus("Файл: " + result.path + ". Не добавляйте в git. Проверьте перед отправкой другу.")
          })}>Экспорт в файл</button>
        </div>}</For>
        <label class="flex flex-col gap-1">Полный путь к .orchestra-template на сервере
          <input class="rounded border border-v2-border-border-base bg-v2-background-bg-base px-3 py-2 min-h-9" placeholder="C:/Downloads/Test2.orchestra-template" aria-label="Путь к файлу шаблона" value={file()} onInput={e => { setFile(e.currentTarget.value); setPending() }} disabled={busy()} />
        </label>
        <button class="rounded border border-v2-border-border-base px-3 py-2 text-start hover:bg-v2-surface-surface-raised focus-visible:outline focus-visible:outline-2 disabled:opacity-50" type="button" disabled={busy() || !file().trim()} onClick={() => void run(async () => { setPending(await props.access.prepareImport(file())) })}>Импорт из файла</button>
        <Show when={pending()}>{value => <div class="flex flex-col gap-2">
          <p>Добавить «{value().name}» в библиотеку? Это не создаёт проект и ничего не запускает.</p>
          <Show when={value().unresolvedRoles?.length}><p role="alert">Неполный шаблон: недоступные роли. Создание проекта будет заблокировано.</p></Show>
          <details><summary>Подробности файла</summary><pre class="whitespace-pre-wrap break-all">{value().details}</pre></details>
          <button class="rounded border border-v2-border-border-base px-3 py-2 text-start hover:bg-v2-surface-surface-raised focus-visible:outline focus-visible:outline-2 disabled:opacity-50" type="button" disabled={busy()} onClick={() => void run(async () => {
            await props.access.confirmImport(value().token)
            setPending()
            setEntries(await props.access.list())
            setStatus("Шаблон добавлен в библиотеку. Ничего не запущено.")
          })}>Подтвердить импорт</button>
          <button class="rounded border border-v2-border-border-base px-3 py-2 text-start hover:bg-v2-surface-surface-raised focus-visible:outline focus-visible:outline-2 disabled:opacity-50" type="button" disabled={busy()} onClick={() => setPending()}>Отмена</button>
        </div>}</Show>
        <Show when={status()}><p role="status" class="break-all">{status()}</p></Show>
      </div>
    </details>
  )
}

export function TemplateFilesConnected() {
  const layout = useLayout(), global = useGlobal()

  const connection = createMemo(() => {
    const route = layout.route()
    const key = route.type === "session" ? route.server : layout.home.selection().server

    return global.servers.list().find(item => ServerConnection.key(item) === key)
  })

  const context = useServerCtx(connection)

  return <Show when={context()} keyed>{ctx => <TemplateFiles access={{
    list: () => ctx.sdk.api.orchestra.projectTemplate.list(),
    projects: () => ctx.sdk.api.orchestra.project.list(),
    exportFile: (templateID, projectID) => ctx.sdk.api.orchestra.projectTemplate.exportFile({ templateID, projectID }),
    prepareImport: path => ctx.sdk.api.orchestra.projectTemplate.prepareImport({ path }),
    confirmImport: token => ctx.sdk.api.orchestra.projectTemplate.confirmImport({ token }),
  }} />}</Show>
}
