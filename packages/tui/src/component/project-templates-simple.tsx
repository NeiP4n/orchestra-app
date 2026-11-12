import type { ProjectTemplateReader } from "@orchestra/core/project-template-reader"
import { createEffect, createSignal, For, onMount, Show } from "solid-js"
import type { ProjectTemplateTriggerReview } from "@orchestra/core/project-template-trigger-review"
import type { ProjectTemplateLinkReview } from "@orchestra/core/project-template-link-review"
import type { ProjectTemplateCoreMigration } from "@orchestra/core/project-template-core-migration"
import { templateErrorMessages } from "@orchestra/core/project-template-errors"
import { templateFailureReason } from "@orchestra/core/project-template-errors"
import { useT } from "../util/i18n"
import { HoverAction } from "./hover-action"
import { useTheme } from "../context/theme"
import { type InputRenderable, TextAttributes } from "@opentui/core"
import { selectionBackground } from "../ui/hover"

const linkReason: Record<ProjectTemplateLinkReview.Reason, string> = {
  credentials: "Login or password in the link", query: "Query parameters may contain private data", fragment: "Fragment may contain private data",
  local: "Local address belongs to the original machine", scheme: "Only public HTTP(S) links can be copied", secret: "Secret-like data in the link", invalid: "Invalid link",
}
const triggerReason: Record<ProjectTemplateTriggerReview.Item["reason"], string> = {
  "browser-rebind": "Rebind page/chat and sign in again; starts paused.",
  "browser-links-omitted": "Some links were omitted; choose page/chat and sign in again; starts paused.",
  "time-review": "Check instruction and credential bindings; starts paused.",
  "unsupported-event": "Internal event cannot be imported without a reviewed local action plan. Creation will be blocked.",
}
export interface ProjectTemplatesKeys {
  move: (delta: number) => void
  activate: () => void
  input: () => InputRenderable | undefined
}

/** Adapter must prepare/revalidate in the background. No authority comes from display or a digest.
 * Only confirmSave/confirmCreate may mutate, and only for the prepared operation they receive.
 * Labels, automatic new folder/name choice and partial-failure recovery belong to the adapter. */
export interface ProjectTemplatesAccess {
  remove?: (id:string,digest:string)=>Promise<void>
  copyPath?: (path: string) => Promise<void>
  openFolder?: (path: string) => Promise<void>
  exportFile?: (templateID: string) => Promise<{ path: string; warning: string }>
  prepareImport?: (path: string) => Promise<{ token: string; name: string; details: string; unresolvedRoles?: readonly string[] }>
  confirmImport?: (token: string) => Promise<unknown>
  list: () => Promise<readonly { id: string; name: string; digest?: string }[]>
  prepareSave: (templateID?: string) => Promise<{ token: string; name: string; details: string; unresolvedRoles?: readonly string[]; browserBindings?: readonly ProjectTemplateReader.BrowserBindingIssue[]; omittedLinks?: readonly ProjectTemplateLinkReview.Issue[]; triggerReview?: readonly ProjectTemplateTriggerReview.Item[] }>
  confirmSave: (token: string, omitUnsafeLinks?: boolean, omitInvalidBrowserBindings?: boolean, acceptUnresolvedRoles?: boolean) => Promise<void>
  prepareMigration?: (templateID: string,destinationRoot?:string) => Promise<{token:string;name:string;details:string;directory?:string;roleChanges?:readonly ProjectTemplateCoreMigration.Change[]}>
  prepareCreate: (templateID: string,destinationRoot?:string) => Promise<{ token: string; name: string; details: string; directory?:string; triggerReview?: readonly ProjectTemplateTriggerReview.Item[] }>
  confirmCreate: (token: string) => Promise<void>
}
const processTemplate = (details: string): { skillCount: number; sessions: { title: string; role: string }[]; runtimeRoles: string[] } | undefined => {
  try {
    const value = JSON.parse(details)
    if (value?.format === "orchestra.project-template" && value.version === 2 && Array.isArray(value.process?.skills))
      return { skillCount: value.process.skills.length,
        sessions: Array.isArray(value.sessions) ? value.sessions.filter((s: {title?: unknown; role?: unknown}) => typeof s.title === "string" && typeof s.role === "string") : [],
        runtimeRoles: Array.isArray(value.process.roles) ? value.process.roles.filter((r: {runtime?: unknown}) => !!r.runtime).map((r: {agent: string}) => r.agent) : [],
      }
  } catch { /* Plain-text v1 details are not process templates. */ }
  return undefined
}
export function ProjectTemplatesSimple(props: {
  access: ProjectTemplatesAccess
  canSave: boolean
  keys?: (keys: ProjectTemplatesKeys) => void
  scrollIntoView?: (id: string) => void
}) {
  const theme = useTheme().surface("dialog")
  const tr = useT()
  const [templates, setTemplates] = createSignal<readonly { id: string; name: string; digest?: string }[]>([])
  const [cursor, setCursor] = createSignal("save")
  const [removing,setRemoving]=createSignal<{id:string;name:string;digest:string}>()
  const [busy, setBusy] = createSignal(false)
  const [details, setDetails] = createSignal(false)
  let destinationInput: InputRenderable | undefined
  let pathInput: InputRenderable | undefined
  const [destination,setDestination]=createSignal("")
  const [importPath, setImportPath] = createSignal("")
  const [exportPath, setExportPath] = createSignal("")
  const [message, setMessage] = createSignal("")
  const [reason, setReason] = createSignal<string>()
  const [failedTemplate, setFailedTemplate] = createSignal<string>()
  const [refreshFailed, setRefreshFailed] = createSignal(false)
  const [prepared, setPrepared] = createSignal<{
    kind: "save" | "create" | "import"
    updating?: boolean
    token: string
    name: string
    details: string
    unresolvedRoles?: readonly string[]; browserBindings?: readonly ProjectTemplateReader.BrowserBindingIssue[]
    omittedLinks?: readonly ProjectTemplateLinkReview.Issue[]
    triggerReview?: readonly ProjectTemplateTriggerReview.Item[]
    directory?:string
    roleChanges?: readonly ProjectTemplateCoreMigration.Change[]
  }>()
  const run = async (action: () => Promise<void>, kind?: "save" | "create") => {
    if (busy()) return
    setBusy(true)
    try {
      await action()
    } catch (error) {
      setReason(templateFailureReason(error))
      setPrepared()
      setMessage("")
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
      setReason()
      setRefreshFailed(false)
      if (kind === "create") setFailedTemplate(id)
      if (kind === "save" && !props.canSave) return
      if (kind === "save" && id === undefined) await refresh()
      const result = kind === "save" ? await props.access.prepareSave(id) : await props.access.prepareCreate(id!,destination())
      if(kind === "create" && destination().trim() && !("directory" in result && result.directory)){setReason("Project location is unavailable on this server. Update and restart the background server and TUI.");return}
      setPrepared({ kind, updating: kind === "save" && id !== undefined, ...result })
      setCursor(collisions().length ? "replace-" + collisions()[0]!.id : "confirm")
    }, kind)
  const confirm = () =>
    run(async () => {
      const current = prepared()
      if (!current) return
      // Consume the pending operation before awaiting: double clicks cannot confirm the same token twice.
      setPrepared()
      try {
        if (current.kind === "save") {
          if (current.unresolvedRoles?.length) await props.access.confirmSave(current.token, !!current.omittedLinks?.length, !!current.browserBindings?.length, true)
          else if (current.browserBindings?.length) await props.access.confirmSave(current.token, !!current.omittedLinks?.length, true)
          else await props.access.confirmSave(current.token, !!current.omittedLinks?.length)
        }
        else if(current.kind === "import") await props.access.confirmImport!(current.token)
        else await props.access.confirmCreate(current.token)
      } catch (error) {
        setReason(templateFailureReason(error))
        // Keep this exact durable operation, never prepare a second project after partial commit.
        setPrepared(current)
        setMessage("Confirm the same operation again to continue without creating a second copy.")
        return
      }
      // The commit succeeded. A list-refresh failure must never offer duplicate creation.
      try {
        await refresh()
      } catch {
        setRefreshFailed(true)
      }
      setMessage(
        current.kind === "save"
          ? current.updating ? "Template updated. No duplicate was created." : "Project saved as a template. Chats, data and secrets were not saved."
          : current.kind === "import" ? "Template imported to the library. Nothing was started. Choose Create to make a new project." : "Project created. Fill the empty Vault and sign in to browsers. Schedules are paused.",
      )
    })
  const collisions = () => {
    const current = prepared()
    return current?.kind === "save" && !current.updating
      ? templates().filter((row) => row.name === current.name)
      : []
  }
  const actions = () => removing() ? ["confirm-remove","cancel-remove"] : prepared()
    ? [...collisions().map((row) => "replace-" + row.id), "confirm", "cancel", "details"]
    : [...(reason() === templateErrorMessages.TEMPLATE_CORE_ROLE && props.access.prepareMigration && failedTemplate() ? ["migrate-core"] : []), ...(props.canSave ? ["save"] : []), ...templates().flatMap((row) => [`create-${row.id}`, ...(props.canSave ? [`update-${row.id}`] : []), ...(props.access.exportFile && props.canSave ? [`export-${row.id}`] : []), ...(props.access.remove && row.digest ? [`remove-${row.id}`] : [])]), "destination", ...(props.access.prepareImport ? ["import-path", "import"] : []), ...(exportPath() ? ["copy-path", "open-folder"] : [])]
  const focused = () => actions().includes(cursor()) ? cursor() : actions()[0]
  const cancel = () => {
    setPrepared()
    setDetails(false)
    setCursor("save")
  }
  const activate = (id = focused()) => {
    if (busy() || !id) return
    setCursor(id)
    if (id === "confirm-remove" && removing() && props.access.remove) void run(async()=>{
      const selected=removing()!
      await props.access.remove!(selected.id,selected.digest)
      setRemoving();setReason();await refresh();setMessage("Template removed from the list. Projects and exported files were kept.")
    })
    else if(id === "cancel-remove")setRemoving()
    else if(id.startsWith("remove-") && props.access.remove){
      const row=templates().find(r=>r.id===id.slice(7))
      if(row?.digest){setRemoving({id:row.id,name:row.name,digest:row.digest});setCursor("cancel-remove");setMessage("");setReason()}
    }
    else if (id === "migrate-core" && props.access.prepareMigration && failedTemplate()) void run(async () => {
      let result
      try { result = await props.access.prepareMigration!(failedTemplate()!,destination()) }
      catch(error) {
        const hint = templateFailureReason(error)
        setReason(hint === templateErrorMessages.TEMPLATE_CORE_ROLE ? "Another built-in/runtime role still differs. Update and restart the background server; custom runtime roles must be restored separately." : hint)
        setMessage("")
        return
      }
      if(destination().trim() && !result.directory){setReason("Project location is unavailable on this server. Update and restart the background server and TUI.");return}
      if (!result.roleChanges) { setReason("Role comparison is unavailable on this server. Update and restart the background server and TUI."); setMessage(""); return }
      setReason(); setMessage(""); setPrepared({kind:"create",...result}); setCursor("confirm")
    }, "create")
    else if (id === "destination") destinationInput?.focus()
    else if (id === "import-path") pathInput?.focus()
    else if (id === "copy-path" && exportPath() && props.access.copyPath) void run(async () => {
      await props.access.copyPath?.(exportPath())
      setMessage("Path copied.")
    })
    else if (id === "open-folder" && exportPath() && props.access.openFolder) void run(async () => {
      await props.access.openFolder?.(exportPath())
    })
    else if (!prepared() && id === "import") void run(async()=>{
      const result = await props.access.prepareImport!(importPath())
      setPrepared({kind:"import",...result});setCursor("confirm");setDetails(false)
    })
    else if (!prepared() && id.startsWith("export-")) void run(async()=>{
      const result = await props.access.exportFile!(id.slice(7))
      setExportPath(result.path);setMessage("Template exported to the project folder. Do not commit this file to git. Review before sharing.")
    })
    else if (id.startsWith("replace-") && collisions().some((row) => row.id === id.slice(8))) void prepare("save", id.slice(8))
    else if (id === "confirm") void confirm()
    else if (id === "cancel") cancel()
    else if (id === "details") setDetails(!details())
    else if (!prepared() && id === "save") void prepare("save")
    else if (!prepared() && id.startsWith("create-")) void prepare("create", id.slice(7))
    else if (!prepared() && id.startsWith("update-")) void prepare("save", id.slice(7))
  }
  props.keys?.({
    move: (delta) => {
      if (busy()) return
      const ids = actions()
      if (!ids.length) return
      const index = Math.max(0, ids.indexOf(focused() ?? ""))
      setCursor(ids[Math.max(0, Math.min(ids.length - 1, index + delta))])
    },
    activate: () => focused() === "import-path" ? activate("import") : activate(),
    input: () => !prepared() ? focused() === "destination" ? destinationInput : focused() === "import-path" ? pathInput : undefined : undefined,
  })
  createEffect(() => {
    const id = focused()
    if (!id) return
    if (id === "destination") destinationInput?.focus()
    else destinationInput?.blur()
    if (id === "import-path") pathInput?.focus()
    else pathInput?.blur()
    props.scrollIntoView?.(`project-templates.${id}`)

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
      <box flexDirection="row" gap={1} flexWrap="wrap" alignItems="center">
        <text fg={theme.text.base} attributes={TextAttributes.BOLD}>{tr("Project templates")} · {templates().length}</text>
        <Action id="save" label={tr("Save template")} disabled={!props.canSave || !!prepared()} />
      </box>
      <Show when={!prepared() && !removing()}>
        <text fg={theme.text.muted} wrapMode="word">{tr("Project parent folder (optional). Empty keeps the default; a fresh subfolder is created inside it.")}</text>
        <box id="project-templates.destination" onMouseDown={() => {setCursor("destination");destinationInput?.focus()}}><input ref={node => {destinationInput=node}} value={destination()} onInput={setDestination} placeholder={tr("Default project location")} textColor={theme.text.base} focusedTextColor={theme.text.base} cursorColor={theme.text.base} /></box>
      </Show>
      <Show when={props.access.prepareImport && !prepared()}>
        <box flexDirection="row" gap={1} alignItems="center">
          <box flexGrow={1} minWidth={10} onMouseDown={() => { setCursor("import-path"); pathInput?.focus() }} backgroundColor={focused() === "import-path" ? selectionBackground(theme) : theme.background.raised.base} paddingLeft={1} paddingRight={1}>
            <input id="project-templates.import-path" ref={(value: InputRenderable) => { pathInput = value }} focused={focused() === "import-path"} value={importPath()} placeholder={tr("Template file (.orchestra-template)")} onInput={setImportPath} textColor={theme.text.base} focusedTextColor={theme.text.base} cursorColor={theme.text.base} />
          </box>
          <Action id="import" label={tr("Import")} disabled={!importPath().trim()} />
        </box>
      </Show>
      <Show when={!prepared() && !removing()}>
        <box flexDirection="column">
          <Show when={templates().length === 0}>
            <text fg={theme.text.muted} wrapMode="word">{tr("No templates yet. Save a project above.")}</text>
          </Show>
          <For each={templates()}>{template => (
            <box flexDirection="row" flexWrap="wrap" gap={1}>
              <Action id={`create-${template.id}`} label={template.name + " · " + tr("Create")} />
              <Show when={template.digest || templates().filter(r=>r.name===template.name).length > 1}><text fg={theme.text.muted}>#{(template.digest ?? template.id).slice(-8)}</text></Show>
              <Show when={props.access.remove && template.digest}><Action id={`remove-${template.id}`} label={tr("Remove from list")} /></Show>
              <Show when={props.canSave && props.access.exportFile}>
                <Action id={`export-${template.id}`} label={tr("Export")} />
              </Show>
              <Show when={props.canSave}>
                <Action id={`update-${template.id}`} label={tr("Update")} />
              </Show>
            </box>
          )}</For>
        </box>
      </Show>
      <Show when={removing()}>{row=><box flexDirection="column" gap={1}>
        <text fg={theme.text.feedback.warning.base} wrapMode="word">{tr("Remove this template from the list? Projects and exported files will stay.")} {row().name} #{row().digest.slice(-8)}</text>
        <box flexDirection="row" gap={1}><Action id="confirm-remove" label={tr("Remove from list")} /><Action id="cancel-remove" label={tr("Cancel")} /></box>
      </box>}</Show>
      <Show when={prepared()}>
        {(current) => (
          <box flexDirection="column" gap={1} paddingTop={1}>
            <text fg={theme.text.base} attributes={TextAttributes.BOLD} wrapMode="word">
              {current().kind === "save" ? tr(current().updating ? "Update" : "Save") : tr(current().kind === "import" ? "Import" : "Create")} «{current().name}»?{" "}
              {current().kind === "save"
                ? tr("Settings only, without chats, data or secrets.")
                : tr("Vault will be empty, browsers signed out and schedules paused.")}
            </text>
            <Show when={current().kind === "create" && current().directory}><text fg={theme.text.base} wrapMode="word">{tr("Project folder: {path}",{path:current().directory!})}</text></Show>
            <Show when={current().roleChanges?.length}>
              <text fg={theme.text.feedback.warning.base} wrapMode="word">{tr("Use this server's built-in roles for the new project only. Project rules, custom roles, instructions and paused schedules stay unchanged. The original template and server rules are not edited.")}</text>
              <For each={current().roleChanges}>{change => <text fg={theme.text.base} wrapMode="word">{`${change.role}: ${change.fields.join(", ")}\nsha256 ${change.fromHash.slice(0,12)} -> ${change.toHash.slice(0,12)}`}</text>}</For>
            </Show>
            <Show when={collisions().length}>
              <text fg={theme.text.feedback.warning.base} wrapMode="word">{tr("A template with this name already exists. Update it or save a separate copy.")}</text>
              <For each={collisions()}>{(row) => <Action id={"replace-" + row.id} label={tr("Update existing template") + (collisions().length > 1 ? " · " + row.id : "")} />}</For>
            </Show>
            <box flexDirection="row" gap={1} flexWrap="wrap">
              <Action id="confirm" label={current().kind === "save" ? (current().unresolvedRoles?.length ? tr("Save incomplete template") : current().omittedLinks?.length ? tr("Save without blocked links") : tr(current().updating ? "Update" : collisions().length ? "Save separate copy" : "Save")) : tr(current().kind === "import" ? "Import" : "Create")} />
              <Action id="cancel" label={tr("Cancel")} />
              <Action id="details" label={details() ? tr("Hide details") : tr("Details")} />
            </box>
            <Show when={!current().unresolvedRoles?.length}>
            <text fg={theme.text.muted} wrapMode="word">{tr(processTemplate(current().details)?.skillCount === 0
              ? "Roles, playbook and fallback models included. Legacy skills may be missing; skill folders are not copied. No automatic script execution."
              : processTemplate(current().details)
                ? "Includes roles, assigned skills, playbook and model fallbacks. Scripts do not run automatically. No project data or global MCP settings."
                : "Skills, role definitions, model fallback lists, project files and global MCP settings are not copied. Review destination configuration.")}</text>
            </Show>
            <Show when={current().triggerReview?.length}>
              <text fg={theme.text.feedback.warning.base} wrapMode="word">{tr("All imported triggers stay paused. Browser checks need a new page/chat binding and sign-in. Review dependencies in Details before enabling.")}</text>
            </Show>
            <Show when={processTemplate(current().details)?.runtimeRoles.length}>
              <text fg={theme.text.muted} wrapMode="word">{tr("Built-in session roles are preserved only with an identical destination runtime definition, including permissions. Different or missing definitions block creation.")}</text>
            </Show>
            <Show when={current().unresolvedRoles?.length}>
              <text fg={theme.text.feedback.warning.base} wrapMode="word">{tr("Some source role definitions are unavailable. Save an incomplete template? Role references, rules and skill assignments are preserved. Creating a project is blocked until the source roles are restored. The original project is unchanged.")}</text>
            </Show>
            <For each={current().browserBindings}>{(issue) => <text fg={theme.text.feedback.warning.base} wrapMode="word">{tr("Browser {browser}: old chat binding is unavailable. Save the browser and links without that binding? A new BrowserAgent will be created when first opened in the new project. The original project is unchanged.", { browser: issue.browser })}</text>}</For>
            <Show when={current().omittedLinks?.length}>
              <text fg={theme.text.feedback.warning.base} wrapMode="word">{tr("Some saved links cannot be copied safely. Save without them, or cancel. The original links will stay in this project.")}</text>
            </Show>
            <Show when={details()}>
              <box flexDirection="column">
                <For each={processTemplate(current().details)?.sessions}>{session => <text fg={theme.text.muted} wrapMode="word">{tr("Session {session}: role {role}", { session: session.title, role: session.role })}</text>}</For>
                <For each={current().unresolvedRoles}>{role => <text fg={theme.text.muted} wrapMode="word">{tr("Unavailable role: {role}", { role })}</text>}</For>
                <For each={current().triggerReview}>{(item) => <text fg={theme.text.muted} wrapMode="word">{tr("Trigger {schedule}: {reason}", { schedule: item.schedule, reason: tr(triggerReason[item.reason]) })}{item.browser ? " " + tr("Browser {browser}", { browser: item.browser }) : ""}</text>}</For>
                <For each={current().omittedLinks}>{(issue) => <text fg={theme.text.muted} wrapMode="word">{tr("Browser {browser}, saved link {link}: {reason}", { browser: issue.browser, link: issue.link, reason: tr(linkReason[issue.reason]) })}</text>}</For>
                <text fg={theme.text.muted} wrapMode="word">{current().details}</text>
              </box>
            </Show>
          </box>
        )}
      </Show>
      <Show when={exportPath()}>
        <box flexDirection="column">
          <text fg={theme.text.base} wrapMode="word">{tr("File: {path}", {path:exportPath()})}</text>
          <text fg={theme.text.muted} wrapMode="word">{tr("Send this file to your friend. They choose Import from file.")}</text>
          <Action id="copy-path" label={tr("Copy path")} disabled={!props.access.copyPath} />
          <Action id="open-folder" label={tr("Open folder")} disabled={!props.access.openFolder} />
          <Show when={!props.access.openFolder}><text fg={theme.text.muted} wrapMode="word">{tr("Folder is on the server. Open it on that computer.")}</text></Show>
        </box>
      </Show>
      <Show when={busy()}>
        <text fg={theme.text.muted}>{tr("Preparing…")}</text>
      </Show>
      <Show when={!prepared() && reason() === templateErrorMessages.TEMPLATE_CORE_ROLE && props.access.prepareMigration && failedTemplate()}><Action id="migrate-core" label={tr("Review current built-in roles")} /></Show>
      <Show when={message() || reason()}>
        <text fg={theme.text.base} wrapMode="word">{reason() ? tr(reason()!) : ""}{message() ? (reason() ? " " : "") + tr(message()) : ""}{refreshFailed() ? tr(" The list has not refreshed yet.") : ""}</text>
      </Show>
      <text fg={theme.text.muted} wrapMode="word">{tr(props.access.prepareImport ? "↑↓ select · Enter action · Paste path to import" : "↑↓ select · Enter action")}</text>
    </box>
  )
}
