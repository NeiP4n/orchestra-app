import { tr } from "../../util/i18n"
import { createEffect, createMemo, createResource, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { TextAttributes, type RGBA } from "@opentui/core"
import { Federation } from "@orchestra/schema/federation"
import { DialogRules } from "../../component/dialog-rules"
import { useClient } from "../../context/client"
import { useDialog } from "../../ui/dialog"
import { hoverBackground } from "../../ui/hover"
import { useData } from "../../context/data"
import { useProjects } from "../../context/projects"
import { usePromptRef } from "../../context/prompt"
import { useTheme, useThemes } from "../../context/theme"
import { emptyPrompt } from "../../prompt/history"

// The Society chat: one transcript where the operator writes once, addresses a member
// Orchestrator by its call sign (@Atlas) and sees every answer under that member's name.
// Quick replies are drawn here too, so a question from the chat can be answered with a click.

type ThemeLike = ReturnType<typeof useTheme>

// A call sign keeps its colour for as long as the group keeps its project order. The categorical
// ramp is the theme's role for "one of N identities", so a roster never borrows a feedback colour.
export function callsignColor(theme: ThemeLike, callsign: string | undefined): RGBA {
  const base = (callsign ?? "").replace(/\d+$/, "")
  const index = Math.max(0, Federation.callsignPool.indexOf(base as (typeof Federation.callsignPool)[number]))
  const lap = Number((callsign ?? "").match(/\d+$/)?.[0] ?? 1) - 1
  const palette = theme.categorical
  return palette[(index + lap) % palette.length]![200]
}

// What the Council receives once every invited Orchestrator answered: one card per member.
export function CouncilResultsCard(props: { results: Federation.CouncilResults }) {
  const theme = useTheme()
  const { currentSyntax: syntax } = useThemes()
  const count = () => props.results.proposals.length
  return (
    <box flexDirection="column" gap={1} paddingLeft={2} paddingTop={1} paddingBottom={1} flexShrink={0}>
      <box flexDirection="row" gap={1}>
        <text fg={theme.text.base} attributes={TextAttributes.BOLD} wrapMode="none">
          {tr("Council")}
        </text>
        <text fg={theme.text.base} wrapMode="none" truncate>
          {props.results.subject ?? props.results.group}
        </text>
        <text fg={theme.text.muted} wrapMode="none">
          {count() === 1 ? tr("{count} answer", { count: count() }) : tr("{count} answers", { count: count() })}
        </text>
      </box>
      <For each={props.results.proposals}>
        {(proposal) => {
          const color = () => callsignColor(theme, proposal.callsign)
          return (
            <box flexDirection="column" gap={1} paddingLeft={2}>
              <box flexDirection="row" gap={1}>
                <text fg={color()} attributes={TextAttributes.BOLD} wrapMode="none">
                  {proposal.callsign ?? proposal.name}
                </text>
                <Show when={proposal.callsign}>
                  <text fg={theme.text.muted} wrapMode="none" truncate>
                    {proposal.name}
                  </text>
                </Show>
              </box>
              <markdown
                syntaxStyle={syntax()}
                content={proposal.answer}
                streaming={false}
                internalBlockMode="top-level"
                tableOptions={{ style: "grid", cellPaddingX: 1 }}
                fg={theme.markdown.text}
                bg={theme.background.base}
              />
            </box>
          )
        }}
      </For>
    </box>
  )
}

// Sends `text` as the operator's next message in the open chat.
export function useQuickSend() {
  const promptRef = usePromptRef()
  return (text: string) => {
    const prompt = promptRef.current
    if (!prompt) return
    prompt.set({ ...emptyPrompt(), text })
    prompt.submit()
  }
}

// Replies the assistant offered with <reply-options>: each is a chip that sends its text.
// A sent chip stays on screen as the chosen one, so the chat shows which way the operator went.
export function ReplyOptions(props: { options: ReadonlyArray<Federation.ReplyOption>; settled?: boolean }) {
  const theme = useTheme()
  const send = useQuickSend()
  const [chosen, setChosen] = createSignal<number>()
  const locked = () => props.settled === true || chosen() !== undefined
  return (
    <box flexDirection="row" gap={1} flexWrap="wrap" paddingLeft={2} paddingTop={1} flexShrink={0}>
      <For each={props.options}>
        {(option, index) => {
          const [hover, setHover] = createSignal(false)
          const picked = () => chosen() === index()
          const tone = () =>
            locked() && !picked()
              ? theme.text.action.secondary.disabled
              : hover()
                ? theme.text.action.secondary.hovered
                : theme.text.action.secondary.base
          return (
            <box
              paddingLeft={1}
              paddingRight={1}
              backgroundColor={hover() && !locked() ? hoverBackground(theme, "secondary") : undefined}
              onMouseOver={() => setHover(true)}
              onMouseOut={() => setHover(false)}
              onMouseUp={(event) => {
                event.stopPropagation()
                if (locked()) return
                setChosen(index())
                send(option.send)
              }}
            >
              <text
                wrapMode="none"
                fg={picked() ? theme.text.feedback.success.base : tone()}
                attributes={picked() ? TextAttributes.BOLD : undefined}
              >
                {`${picked() ? "✓" : "▸"} ${option.label}`}
              </text>
            </box>
          )
        }}
      </For>
    </box>
  )
}

// Above the prompt of a Society chat: every member with its call sign. A click puts @Name into the prompt.
export function SocietyRoster(props: { sessionID: string }) {
  const theme = useTheme()
  const data = useData()
  const client = useClient()
  const dialog = useDialog()
  const projects = useProjects()
  const promptRef = usePromptRef()
  const marker = createMemo(() => Federation.groupSupervisor(data.session.get(props.sessionID)?.metadata))
  const [groups, { refetch }] = createResource(
    () => marker()?.groupName,
    () => client.api.orchestra.group.list().catch(() => []),
  )
  const [holds, { refetch: refetchHolds }] = createResource(() =>
    client.api.orchestra.group.holds().catch(() => [] as string[]),
  )
  // The Society's DoD progress, counted by the system from its projects' boards: no model is asked.
  const [progress, { refetch: refetchProgress }] = createResource(
    () => marker()?.groupName,
    (name) => client.api.orchestra.group.status({ name }).catch(() => undefined),
  )
  const done = createMemo(() => (progress.latest?.projects ?? []).reduce((sum, item) => sum + item.done, 0))
  const total = createMemo(() => (progress.latest?.projects ?? []).reduce((sum, item) => sum + item.total, 0))
  const held = createMemo(() => {
    const name = marker()?.groupName
    return name !== undefined && (holds.latest ?? []).includes(name)
  })
  onMount(() => {
    const timer = setInterval(() => {
      void refetch()
      void refetchHolds()
      void refetchProgress()
    }, 5000)
    onCleanup(() => clearInterval(timer))
  })
  const members = createMemo(() => {
    const info = marker()
    if (info?.mode !== "council") return []
    const group = (groups.latest ?? []).find((item) => item.name === info.groupName)
    if (!group) return []
    return Federation.roster(group.projects as never).map((member) => ({
      ...member,
      name: projects.list().find((project) => project.id === member.project)?.name ?? member.project,
      online: projects.list().find((project) => project.id === member.project)?.main !== undefined,
      main: projects.list().find((project) => project.id === member.project)?.main,
    }))
  })
  // Native status, read from the sessions themselves: no model turn is spent to learn who is working or
  // who is waiting for an answer. Only running sessions can ask, so those are the ones worth syncing.
  createEffect(() =>
    data.session.active().forEach((id) => {
      void data.session.permission.sync(id).catch(() => undefined)
      void data.session.form.sync(id).catch(() => undefined)
    }),
  )
  const waiting = (main: string | undefined) =>
    main !== undefined &&
    ((data.session.permission.list(main)?.length ?? 0) > 0 || (data.session.form.list(main)?.length ?? 0) > 0)
  const glyph = (member: { online: boolean; main?: string }) =>
    waiting(member.main) ? "?" : member.main !== undefined && data.session.status(member.main) === "running" ? "◉" : member.online ? "●" : "○"
  const [hover, setHover] = createSignal<string>()
  const [holdHover, setHoldHover] = createSignal(false)
  const mention = (callsign: string) => {
    const prompt = promptRef.current
    if (!prompt) return
    const text = prompt.current.text
    prompt.set({ ...prompt.current, text: `${text}${text && !text.endsWith(" ") ? " " : ""}@${callsign} ` })
    prompt.focus()
  }
  return (
    <Show when={members().length > 0}>
      {/* One row, no wrapping: a Society has six or more members, and a roster that wraps takes the room of
          the conversation. Only the call sign is shown; the project's name appears at the end of the row while
          the pointer is on its chip. */}
      <box flexDirection="row" gap={1} paddingLeft={1} flexShrink={0}>
        {/* While held, no AI of this Society starts, whatever wakes it. The server holds every Society at start. */}
        <box
          paddingLeft={1}
          paddingRight={1}
          backgroundColor={holdHover() ? hoverBackground(theme, "secondary") : undefined}
          onMouseOver={() => setHoldHover(true)}
          onMouseOut={() => setHoldHover(false)}
          onMouseUp={(event) => {
            event.stopPropagation()
            const name = marker()?.groupName
            if (!name) return
            void client.api.orchestra.group
              .hold({ name, held: !held() })
              .then(() => refetchHolds())
              .catch(() => undefined)
          }}
        >
          <text
            wrapMode="none"
            fg={holdHover() ? theme.text.action.secondary.hovered : theme.text.action.secondary.base}
            attributes={held() ? TextAttributes.BOLD : undefined}
          >
            {held() ? `⏸ ${tr("Resume")}` : `⏸ ${tr("Hold")}`}
          </text>
        </box>
        <For each={members()}>
          {(member) => {
            const color = () => callsignColor(theme, member.callsign)
            const hot = () => hover() === member.callsign
            return (
              <box
                onMouseOver={() => setHover(member.callsign)}
                onMouseOut={() => setHover(undefined)}
                onMouseUp={() => mention(member.callsign)}
              >
                <text
                  wrapMode="none"
                  fg={hot() ? theme.background.base : color()}
                  bg={hot() ? color() : undefined}
                  attributes={member.online ? undefined : TextAttributes.DIM}
                >
                  {`${glyph(member)}${member.callsign}`}
                </text>
              </box>
            )
          }}
        </For>
        {/* The Society's rulebook: its AIs follow it, and may add to it. */}
        <box
          onMouseUp={() => {
            const name = marker()?.groupName
            if (name) dialog.replace(() => <DialogRules scope={`society:${name}`} title={name} />)
          }}
        >
          <text fg={theme.text.muted} wrapMode="none">
            {tr("rules")}
          </text>
        </box>
        <Show when={total() > 0}>
          <text fg={theme.text.muted} wrapMode="none">
            {`DoD ${done()}/${total()}`}
          </text>
        </Show>
        <box onMouseUp={() => mention("all")}>
          <text fg={theme.text.muted} wrapMode="none">
            @all
          </text>
        </box>
        <text fg={theme.text.muted} wrapMode="none" truncate flexShrink={1} minWidth={0}>
          {members().find((member) => member.callsign === hover())?.name ?? ""}
        </text>
      </box>
    </Show>
  )
}
