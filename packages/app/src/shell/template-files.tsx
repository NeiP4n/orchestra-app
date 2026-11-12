import { useLanguage } from "@/runtime/i18n/language"
import { createMemo, createSignal, For, Show } from "solid-js"
import { usePlatform } from "@/runtime/platform/platform"
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
  copyPath?: (path: string) => Promise<void>
  openFolder?: (path: string) => Promise<void>
}

export function TemplateFiles(props: { access: TemplateFileAccess; locale?: string }) {
  const t = (ru: string, en: string) => props.locale?.startsWith("en") ? en : ru
  const [entries, setEntries] = createSignal<readonly Entry[]>([])
  const [projects, setProjects] = createSignal<readonly Entry[]>([])
  const [project, setProject] = createSignal("")
  const [file, setFile] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [status, setStatus] = createSignal("")
  const [exportPath, setExportPath] = createSignal("")
  const [loaded, setLoaded] = createSignal(false)
  const [pending, setPending] = createSignal<Awaited<ReturnType<TemplateFileAccess["prepareImport"]>>>()

  const run = async (action: () => Promise<void>) => {
    if (busy()) return
    setBusy(true)
    setStatus("")

    try { await action() } catch { setStatus(t("Не удалось завершить. Проверьте файл и подключение. Повторить можно той же кнопкой.", "Could not finish. Check the file and connection, then try again.")) }
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
      <summary class="cursor-pointer" onClick={() => { if (!loaded()) void load() }}>{t("Шаблоны: экспорт / импорт файла", "Templates: export / import file")}</summary>
      <div class="flex flex-col gap-2 py-2" aria-busy={busy()}>
        <details><summary>{t("О файлах и безопасности", "Files and safety")}</summary><p>{t("Экспорт сохраняется в корне выбранного проекта на сервере. Не добавляйте .orchestra-template в git. Чаты и значения секретов не копируются.", "Exports go to the project root on the server. Do not commit .orchestra-template files. Chats and secret values are not copied.")}</p></details>
        <button class="rounded border border-v2-border-border-base px-2 py-1 text-start hover:bg-v2-surface-surface-raised focus-visible:outline focus-visible:outline-2 disabled:opacity-50" type="button" disabled={busy()} onClick={() => void load()}>{t("Обновить список", "Refresh list")}</button>
        <Show when={!loaded()}><p role="status">{t("Загрузка библиотеки...", "Loading library...")}</p></Show>
        <Show when={loaded() && entries().length === 0}><p>{t("Шаблонов пока нет. Сохраните проект как шаблон в Реестре.", "No templates yet. Save a project as a template in Registry.")}</p></Show>
        <label class="flex flex-col gap-1">{t("Папка проекта для экспорта", "Export project folder")}
          <select class="rounded border border-v2-border-border-base bg-v2-background-bg-base px-2 py-1" aria-label={t("Проект для экспорта", "Export project")} value={project()} onChange={e => setProject(e.currentTarget.value)} disabled={busy()}>
            <For each={projects()}>{row => <option value={row.id}>{row.name}</option>}</For>
          </select>
        </label>
        <For each={entries()}>{entry => <div class="flex flex-wrap items-center gap-2">
          <span class="min-w-0 flex-1 truncate" title={entry.name}>{entry.name}</span>
          <button class="rounded border border-v2-border-border-base px-2 py-1 text-start hover:bg-v2-surface-surface-raised focus-visible:outline focus-visible:outline-2 disabled:opacity-50" type="button" disabled={busy() || !project()} onClick={() => void run(async () => {
            const result = await props.access.exportFile(entry.id, project())
            setExportPath(result.path)
            setStatus(t("Файл: ", "File: ") + result.path + t(". Не добавляйте в git. Проверьте перед отправкой другу.", ". Do not commit to git. Review before sharing."))
          })}>{t("Экспорт в файл", "Export file")}</button>
        </div>}</For>
        <Show when={exportPath()}>
          <p class="break-all">{t("Файл на сервере:", "Server file:")} {exportPath()}</p>
          <p>{t("Отправьте этот файл другу. У него: Импорт из файла.", "Send this file to your friend. They choose Import from file.")}</p>
          <button class="rounded border border-v2-border-border-base px-2 py-1 text-start hover:bg-v2-surface-surface-raised focus-visible:outline focus-visible:outline-2 disabled:opacity-50" type="button" disabled={busy() || !props.access.copyPath} onClick={() => void run(async () => {
            await props.access.copyPath?.(exportPath())
            setStatus(t("Путь скопирован.", "Path copied."))
          })}>{t("Скопировать путь", "Copy path")}</button>
          <button class="rounded border border-v2-border-border-base px-2 py-1 text-start hover:bg-v2-surface-surface-raised focus-visible:outline focus-visible:outline-2 disabled:opacity-50" type="button" disabled={busy() || !props.access.openFolder} onClick={() => void run(async () => {
            await props.access.openFolder?.(exportPath())
          })}>{t("Открыть папку", "Open folder")}</button>
          <Show when={!props.access.openFolder}><p>{t("В браузере нельзя открыть папку сервера. Откройте её на том компьютере по этому пути.", "The folder is on the server. Open it on that computer using this path.")}</p></Show>
        </Show>
        <div class="flex items-center gap-2"><label class="min-w-0 flex-1">
          <input class="w-full rounded border border-v2-border-border-base bg-v2-background-bg-base px-2 py-1 min-h-8" placeholder="C:/Downloads/Test2.orchestra-template" aria-label={t("Путь к файлу шаблона", "Template file path")} value={file()} onInput={e => { setFile(e.currentTarget.value); setPending() }} disabled={busy()} />
        </label>
        <button class="rounded border border-v2-border-border-base px-2 py-1 text-start hover:bg-v2-surface-surface-raised focus-visible:outline focus-visible:outline-2 disabled:opacity-50" type="button" disabled={busy() || !file().trim()} onClick={() => void run(async () => { setPending(await props.access.prepareImport(file())) })}>{t("Импорт из файла", "Import from file")}</button></div>
        <Show when={pending()}>{value => <div class="flex flex-col gap-2">
          <p>{t("Добавить", "Add")} «{value().name}» {t("в библиотеку? Это не создаёт проект и ничего не запускает.", "to the library? No project is created and nothing starts.")}</p>
          <Show when={value().unresolvedRoles?.length}><p role="alert">{t("Неполный шаблон: недоступные роли. Создание проекта будет заблокировано.", "Incomplete template: roles are unavailable. Project creation will be blocked.")}</p></Show>
          <details><summary>{t("Подробности файла", "File details")}</summary><pre class="whitespace-pre-wrap break-all">{value().details}</pre></details>
          <button class="rounded border border-v2-border-border-base px-2 py-1 text-start hover:bg-v2-surface-surface-raised focus-visible:outline focus-visible:outline-2 disabled:opacity-50" type="button" disabled={busy()} onClick={() => void run(async () => {
            await props.access.confirmImport(value().token)
            setPending()
            setEntries(await props.access.list())
            setStatus(t("Шаблон добавлен в библиотеку. Ничего не запущено.", "Template added to the library. Nothing started."))
          })}>{t("Подтвердить импорт", "Confirm import")}</button>
          <button class="rounded border border-v2-border-border-base px-2 py-1 text-start hover:bg-v2-surface-surface-raised focus-visible:outline focus-visible:outline-2 disabled:opacity-50" type="button" disabled={busy()} onClick={() => setPending()}>{t("Отмена", "Cancel")}</button>
        </div>}</Show>
        <Show when={status()}><p role="status" class="break-all">{status()}</p></Show>
      </div>
    </details>
  )
}

export function TemplateFilesConnected() {
  const language = useLanguage()
  const platform = usePlatform()
  const layout = useLayout(), global = useGlobal()

  const connection = createMemo(() => {
    const route = layout.route()
    const key = route.type === "session" ? route.server : layout.home.selection().server

    return global.servers.list().find(item => ServerConnection.key(item) === key)
  })

  const context = useServerCtx(connection)

  return <Show when={context()} keyed>{ctx => <TemplateFiles locale={language.locale()} access={{
    copyPath: path => navigator.clipboard.writeText(path),
    openFolder: ServerConnection.local(connection()) && platform.openPath ? file => platform.openPath!(file.replace(/[\\/][^\\/]+$/, "")) : undefined,
    list: () => ctx.sdk.api.orchestra.projectTemplate.list(),
    projects: () => ctx.sdk.api.orchestra.project.list(),
    exportFile: (templateID, projectID) => ctx.sdk.api.orchestra.projectTemplate.exportFile({ templateID, projectID }),
    prepareImport: path => ctx.sdk.api.orchestra.projectTemplate.prepareImport({ path }),
    confirmImport: token => ctx.sdk.api.orchestra.projectTemplate.confirmImport({ token }),
  }} />}</Show>
}
