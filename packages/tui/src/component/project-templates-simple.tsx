import { createEffect, createSignal, For, onMount, Show } from "solid-js"
import type { ProjectTemplateTriggerReview } from "@orchestra/core/project-template-trigger-review"
import type { ProjectTemplateLinkReview } from "@orchestra/core/project-template-link-review"
import { templateErrorKey } from "@orchestra/core/project-template-errors"
import { useT } from "../util/i18n"
import { HoverAction } from "./hover-action"
import { useTheme } from "../context/theme"
import { TextAttributes } from "@opentui/core"
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
}

/** Adapter must prepare/revalidate in the background. No authority comes from display or a digest.
 * Only confirmSave/confirmCreate may mutate, and only for the prepared operation they receive.
 * Labels, automatic new folder/name choice and partial-failure recovery belong to the adapter. */
export interface ProjectTemplatesAccess {
  list: () => Promise<readonly { id: string; name: string }[]>
  prepareSave: () => Promise<{ token: string; name: string; details: string; omittedLinks?: readonly ProjectTemplateLinkReview.Issue[]; triggerReview?: readonly ProjectTemplateTriggerReview.Item[] }>
  confirmSave: (token: string, omitUnsafeLinks?: boolean) => Promise<void>
  prepareCreate: (templateID: string) => Promise<{ token: string; name: string; details: string; triggerReview?: readonly ProjectTemplateTriggerReview.Item[] }>
  confirmCreate: (token: string) => Promise<void>
}
const processTemplate = (details: string): { skillCount: number } | undefined => {
  try {
    const value = JSON.parse(details)
    if (value?.format === "orchestra.project-template" && value.version === 2 && Array.isArray(value.process?.skills))
      return { skillCount: value.process.skills.length }
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
  const [templates, setTemplates] = createSignal<readonly { id: string; name: string }[]>([])
  const [cursor, setCursor] = createSignal("save")
  const [busy, setBusy] = createSignal(false)
  const [details, setDetails] = createSignal(false)
  const [message, setMessage] = createSignal("")
  const [reason, setReason] = createSignal<string>()
  const [refreshFailed, setRefreshFailed] = createSignal(false)
  const [prepared, setPrepared] = createSignal<{
    kind: "save" | "create"
    token: string
    name: string
    details: string
    omittedLinks?: readonly ProjectTemplateLinkReview.Issue[]
    triggerReview?: readonly ProjectTemplateTriggerReview.Item[]
  }>()
  const run = async (action: () => Promise<void>, kind?: "save" | "create") => {
    if (busy()) return
    setBusy(true)
    try {
      await action()
    } catch (error) {
      setReason(templateErrorKey(error))
      setPrepared()
      setMessage(kind === "save" ? "Template was not saved." : kind === "create" ? "Could not finish. Nothing was replaced. Try again." : "Could not refresh the template list.")
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
      if (kind === "save" && !props.canSave) return
      const result = kind === "save" ? await props.access.prepareSave() : await props.access.prepareCreate(id!)
      setPrepared({ kind, ...result })
      setCursor("confirm")
    }, kind)
  const confirm = () =>
    run(async () => {
      const current = prepared()
      if (!current) return
      // Consume the pending operation before awaiting: double clicks cannot confirm the same token twice.
      setPrepared()
      try {
        if (current.kind === "save") await props.access.confirmSave(current.token, !!current.omittedLinks?.length)
        else await props.access.confirmCreate(current.token)
      } catch (error) {
        setReason(templateErrorKey(error))
        // Keep this exact durable operation, never prepare a second project after partial commit.
        setPrepared(current)
        setMessage(current.kind === "save" ? "Template was not saved. Retry the same save." : "Could not finish. Confirm the same operation again to continue without creating a second copy.")
        return
      }
      setMessage(
        current.kind === "save"
          ? "Project saved as a template. Chats, data and secrets were not saved."
          : "Project created. Fill the empty Vault and sign in to browsers. Schedules are paused.",
      )
      // The commit succeeded. A list-refresh failure must never offer duplicate creation.
      try {
        await refresh()
      } catch {
        setRefreshFailed(true)
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
        <text fg={theme.text.base} attributes={TextAttributes.BOLD}>{tr("Project templates")}</text>
        <text fg={theme.text.muted} wrapMode="word">
          {tr("Project process: roles, skills, rules and settings. No chats, data or secrets.")}
        </text>
      </box>
      <box flexDirection="column">
        <Action id="save" label={tr("Save project as template")} disabled={!props.canSave || !!prepared()} />
        <Show when={!props.canSave}>
          <text fg={theme.text.muted} paddingLeft={3}>{tr("Open a project to save a template.")}</text>
        </Show>
      </box>
      <box flexDirection="column" gap={1}>
        <text fg={theme.text.base} attributes={TextAttributes.BOLD}>{tr("Saved templates · {count}", { count: templates().length })}</text>
        <Show when={templates().length === 0}>
          <box flexDirection="column">
            <Action id="create-empty" label={tr("Create project from template")} disabled />
            <text fg={theme.text.muted} paddingLeft={3} wrapMode="word">{tr("No templates yet. Save a project above.")}</text>
          </box>
        </Show>
        <For each={templates()}>
          {(template) => (
            <box flexDirection="column">
              <text fg={theme.text.base} paddingLeft={3} wrapMode="word">{template.name}</text>
              <Action id={`create-${template.id}`} label={tr("Create project from template")} disabled={!!prepared()} />
            </box>
          )}
        </For>
      </box>
      <Show when={prepared()}>
        {(current) => (
          <box flexDirection="column" gap={1} paddingTop={1}>
            <text fg={theme.text.base} attributes={TextAttributes.BOLD} wrapMode="word">
              {current().kind === "save" ? tr("Save") : tr("Create")} «{current().name}»?{" "}
              {current().kind === "save"
                ? tr("Settings only, without chats, data or secrets.")
                : tr("Vault will be empty, browsers signed out and schedules paused.")}
            </text>
            <text fg={theme.text.muted} wrapMode="word">{tr(processTemplate(current().details)?.skillCount === 0
              ? "Roles, playbook and fallback models included. Legacy skills may be missing; skill folders are not copied. No automatic script execution."
              : processTemplate(current().details)
                ? "Includes roles, assigned skills, playbook and model fallbacks. Scripts do not run automatically. No project data or global MCP settings."
                : "Skills, role definitions, model fallback lists, project files and global MCP settings are not copied. Review destination configuration.")}</text>
            <Show when={current().triggerReview?.length}>
              <text fg={theme.text.feedback.warning.base} wrapMode="word">{tr("All imported triggers stay paused. Browser checks need a new page/chat binding and sign-in. Review dependencies in Details before enabling.")}</text>
            </Show>
            <Show when={current().omittedLinks?.length}>
              <text fg={theme.text.feedback.warning.base} wrapMode="word">{tr("Some saved links cannot be copied safely. Save without them, or cancel. The original links will stay in this project.")}</text>
            </Show>
            <box flexDirection="row" gap={1} flexWrap="wrap">
              <Action id="confirm" label={current().kind === "save" ? (current().omittedLinks?.length ? tr("Save without blocked links") : tr("Save")) : tr("Create")} />
              <Action id="cancel" label={tr("Cancel")} />
              <Action id="details" label={details() ? tr("Hide details") : tr("Details")} />
            </box>
            <Show when={details()}>
              <box flexDirection="column">
                <For each={current().triggerReview}>{(item) => <text fg={theme.text.muted} wrapMode="word">{tr("Trigger {schedule}: {reason}", { schedule: item.schedule, reason: tr(triggerReason[item.reason]) })}{item.browser ? " " + tr("Browser {browser}", { browser: item.browser }) : ""}</text>}</For>
                <For each={current().omittedLinks}>{(issue) => <text fg={theme.text.muted} wrapMode="word">{tr("Browser {browser}, saved link {link}: {reason}", { browser: issue.browser, link: issue.link, reason: tr(linkReason[issue.reason]) })}</text>}</For>
                <text fg={theme.text.muted} wrapMode="word">{current().details}</text>
              </box>
            </Show>
          </box>
        )}
      </Show>
      <Show when={busy()}>
        <text fg={theme.text.muted}>{tr("Preparing…")}</text>
      </Show>
      <Show when={message()}>
        <text fg={theme.text.base} wrapMode="word">{tr(message())}{reason() ? " " + tr(reason()!) : ""}{refreshFailed() ? tr(" The list has not refreshed yet.") : ""}</text>
      </Show>
      <text fg={theme.text.muted}>{tr("↑↓ select · Enter action")}</text>
    </box>
  )
}
