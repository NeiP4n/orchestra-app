import { tr } from "../util/i18n"
import { TextAttributes, type InputRenderable } from "@opentui/core"
import { createResource, createSignal, For, Show, type JSX } from "solid-js"
import { useConfig } from "../config"
import { useClient } from "../context/client"
import { useProjects } from "../context/projects"
import { useRoute } from "../context/route"
import { useTheme } from "../context/theme"
import type { DialogContext } from "../ui/dialog"
import { hoverBackground } from "../ui/hover"
import { useToast } from "../ui/toast"
import { errorMessage } from "../util/error"
import { useGroupT } from "../util/i18n-groups"
import { Button } from "./devtools-registry"
import { Header } from "./dialog-rooms"

// Every group is two lines: what it is, then what can be done with it. The mode is read here and
// changed in the form below, because a mode change replaces the group's chat.
const LABEL_WIDTH = 9

export function DialogGroups(props: { onClose?: () => void }) {
  const client = useClient()
  const config = useConfig().data
  const projects = useProjects()
  const route = useRoute()
  const theme = useTheme().surface("dialog")
  const toast = useToast()
  const t = useGroupT()
  let nameField: InputRenderable | undefined
  const [groups, { refetch }] = createResource(() => client.api.orchestra.group.list())
  const [picked, setPicked] = createSignal<readonly string[]>([])
  const [armed, setArmed] = createSignal<string>()
  const [opening, setOpening] = createSignal<string>()
  const [draftMode, setDraftMode] = createSignal<"lead" | "council">("lead")
  const [editing, setEditing] = createSignal<string>()
  const listed = () => (groups.error ? undefined : groups.latest) ?? []

  const act = (action: () => Promise<unknown>) =>
    void action().then(() => refetch()).catch((error: unknown) => toast.show({ message: errorMessage(error), variant: "error" }))

  const toggle = (id: string) => setPicked((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]))

  type GroupToStart = { name: string; supervisor?: string; mode?: "lead" | "council" }

  const createSupervisor = async (group: GroupToStart) => {
    const mode = group.mode ?? "lead"
    setOpening(group.name)
    try {
      // The server owns the group chat: it opens the group's existing chat and only creates one
      // when there is none, inside the group's own directory. Never navigate to a stored
      // supervisor id: a chat removed elsewhere would resolve to a missing session and the
      // session route would fall back to a brand-new project session.
      const chat = await client.api.orchestra.group.chat({ name: group.name, mode })
      // A failed refresh must not hide the chat that was just created.
      await Promise.resolve(refetch?.()).catch(() => {})
      route.navigate({ type: "session", sessionID: chat.sessionID })
      props.onClose?.()
    } catch (error) {
      toast.show({ message: errorMessage(error), variant: "error" })
    } finally {
      setOpening(undefined)
    }
  }

  const reset = () => {
    if (nameField) nameField.value = ""
    setPicked([])
    setDraftMode("lead")
    setEditing(undefined)
  }

  const save = () => {
    const name = nameField?.value.trim()
    if (!name) return toast.show({ message: t("Enter a group name."), variant: "error" })
    if (picked().length === 0) return toast.show({ message: t("Pick at least one project."), variant: "error" })
    const members = [...picked()]
    const mode = draftMode()
    const previous = listed().find((item) => item.name === name)
    act(async () => {
      // A chat carries the mode it was created in, so the chat of the old mode is stale once the
      // mode changes. Drop it before the save that rebinds the group to the new mode.
      const stale = previous?.supervisor !== undefined && (previous.mode ?? "lead") !== mode ? previous.supervisor : undefined
      if (stale) await client.api.session.remove({ sessionID: stale })
      await client.api.orchestra.group.save({ name, projects: members as never, mode, supervisor: undefined })
      reset()
    })
  }

  const edit = (group: { name: string; projects: readonly string[]; mode?: "lead" | "council" }) => {
    if (nameField) nameField.value = group.name
    setPicked(group.projects)
    setDraftMode(group.mode ?? "lead")
    setEditing(group.name)
  }

  const link = (name: string) =>
    act(async () => {
      const { pairs } = await client.api.orchestra.group.link({ name })
      toast.show({
        message: pairs === 0 ? t("Nothing to link: a group needs two projects.") : t("Linked {count} pair(s).", { count: pairs }),
        variant: "success",
      })
    })

  const remove = (name: string) => {
    if (armed() !== name) return setArmed(name)
    setArmed()
    act(() => client.api.orchestra.group.remove({ name }))
  }

  return (
    <box paddingLeft={2} paddingRight={2} paddingBottom={1} gap={1}>
      <Header title={t("Project groups")} onClose={props.onClose} />
      <Show when={groups.error}>
        {(error) => (
          <text fg={theme.text.feedback.error.base} wrapMode="word">
            {errorMessage(error())}
          </text>
        )}
      </Show>
      <Show when={groups.loading && groups.latest === undefined}>
        <text fg={theme.text.muted}>{t("Loading groups…")}</text>
      </Show>
      <Show
        when={listed().length > 0}
        fallback={
          <Show when={!groups.loading && !groups.error}>
            <text fg={theme.text.muted}>{t("No groups yet.")}</text>
          </Show>
        }
      >
        <For each={listed()}>
          {(group) => (
            <box flexDirection="column">
              <box flexDirection="row" gap={1}>
                <box flexGrow={1} minWidth={0}>
                  <text fg={theme.text.base} wrapMode="none" truncate>
                    <span style={{ bold: true }}>{group.name}</span>
                    <span style={{ fg: theme.text.muted }}>{` · ${group.projects.length} ${group.projects.length === 1 ? "project" : "projects"}`}</span>
                  </text>
                </box>
                <text fg={theme.text.muted} wrapMode="none">
                  {(group.mode ?? "lead") === "council" ? t("Council") : t("Coordinator")}
                </text>
              </box>
              <box flexDirection="row" gap={1}>
                <Button
                  variant="primary"
                  disabled={opening() === group.name}
                  onClick={() => void createSupervisor({ name: group.name, supervisor: group.supervisor, mode: group.mode ?? "lead" })}
                >
                  {opening() === group.name
                    ? t("Creating...")
                    : group.supervisor
                      ? (group.mode ?? "lead") === "council"
                        ? tr("★ Society · Open")
                        : tr("★ President · Open")
                      : (group.mode ?? "lead") === "council"
                        ? tr("+ Create Society")
                        : tr("+ Create President")}
                </Button>
                <Button onClick={() => edit(group)}>{t("Edit")}</Button>
                <Button onClick={() => link(group.name)}>{t("Link all")}</Button>
                <Button onLeave={() => setArmed()} onClick={() => remove(group.name)}>
                  {armed() === group.name ? t("Delete?") : t("Delete")}
                </Button>
              </box>
            </box>
          )}
        </For>
      </Show>

      <text fg={theme.text.base} attributes={TextAttributes.UNDERLINE}>
        {editing() ? t("Edit group") : t("New group")}
      </text>
      <Field label={t("Name")}>
        <input
          width={24}
          cursorStyle={config.cursor}
          ref={(element: InputRenderable) => {
            nameField = element
          }}
          onMouseDown={() => nameField?.focus()}
          placeholder={t("Group name")}
          placeholderColor={theme.text.muted}
          textColor={theme.text.formfield.base}
          focusedTextColor={theme.text.formfield.focused}
          cursorColor={theme.text.formfield.focused}
          backgroundColor={theme.background.formfield.base}
          onSubmit={save}
        />
        <Button variant="primary" onClick={save}>
          {t("Save group")}
        </Button>
      </Field>
      <Field label={t("Mode")}>
        <Chip label={t("Coordinator")} selected={draftMode() === "lead"} onClick={() => setDraftMode("lead")} />
        <Chip label={t("Council")} selected={draftMode() === "council"} onClick={() => setDraftMode("council")} />
      </Field>
      <Show
        when={projects.loaded()}
        fallback={
          <text fg={theme.text.muted}>
            {projects.error() ? t("Couldn't load projects") : t("Loading projects…")}
          </text>
        }
      >
        <Show when={projects.list().length > 0} fallback={<text fg={theme.text.muted}>{t("Create projects first.")}</text>}>
          <Field label={t("Projects")}>
            <For each={projects.list()}>
              {(project) => <Chip label={project.name} selected={picked().includes(project.id)} onClick={() => toggle(project.id)} />}
            </For>
          </Field>
        </Show>
      </Show>
    </box>
  )
}

// A labelled row of the form: labels line up in one column so the controls read as a single stack.
function Field(props: { label: string; children: JSX.Element }) {
  const theme = useTheme().surface("dialog")
  return (
    <box flexDirection="row" gap={1}>
      <box width={LABEL_WIDTH} flexShrink={0}>
        <text fg={theme.text.muted} wrapMode="none">
          {props.label}
        </text>
      </box>
      <box flexDirection="row" gap={1} flexWrap="wrap" flexGrow={1} minWidth={0}>
        {props.children}
      </box>
    </box>
  )
}

// A chip marks its own selection state: filled when chosen, hollow when not.
function Chip(props: { label: string; selected: boolean; onClick: () => void }) {
  const theme = useTheme().surface("dialog")
  const [hover, setHover] = createSignal(false)
  const tone = () =>
    hover() ? theme.text.base : props.selected ? theme.text.formfield.selected : theme.text.formfield.base
  return (
    <box
      flexShrink={0}
      paddingLeft={1}
      paddingRight={1}
      backgroundColor={
        hover() ? hoverBackground(theme) : props.selected ? theme.background.formfield.selected : undefined
      }
      onMouseOver={() => setHover(true)}
      onMouseOut={() => setHover(false)}
      onMouseUp={(event) => {
        event.stopPropagation()
        props.onClick()
      }}
    >
      <text fg={tone()} wrapMode="none">
        {`${props.selected ? "■" : "□"} ${props.label}`}
      </text>
    </box>
  )
}

export function openGroupsDialog(dialog: DialogContext, options?: { onClose?: () => void }) {
  dialog.replace(
    () => (
      <DialogGroups
        onClose={() => {
          dialog.clear()
          options?.onClose?.()
        }}
      />
    ),
    undefined,
    { size: "large" },
  )
  dialog.setCentered(true)
}
