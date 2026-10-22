import { tr } from "../../util/i18n"
import { createMemo, createResource, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { TextAttributes, type RGBA } from "@opentui/core"
import { Federation } from "@orchestra/schema/federation"
import { useClient } from "../../context/client"
import { useData } from "../../context/data"
import { useProjects } from "../../context/projects"
import { usePromptRef } from "../../context/prompt"
import { neuralPalette } from "../../component/neural"
import { useTheme, useThemes } from "../../context/theme"
import { emptyPrompt } from "../../prompt/history"
import { SplitBorder } from "../../ui/border"

// The Society chat: one transcript where the operator writes once, addresses a member
// Orchestrator by its call sign (@Atlas) and sees every answer under that member's name.
// Quick replies are drawn here too, so a question from the chat can be answered with a click.

type ThemeLike = ReturnType<typeof useTheme>

// A call sign keeps its colour for as long as the group keeps its project order.
export function callsignColor(theme: ThemeLike, callsign: string | undefined): RGBA {
  const palette = [
    theme.text.feedback.info.base,
    theme.text.feedback.success.base,
    theme.text.feedback.warning.base,
    theme.hue.accent[200],
    theme.hue.interactive[300],
  ]
  const base = (callsign ?? "").replace(/\d+$/, "")
  const index = Math.max(0, Federation.callsignPool.indexOf(base as (typeof Federation.callsignPool)[number]))
  const lap = Number((callsign ?? "").match(/\d+$/)?.[0] ?? 1) - 1
  return palette[(index + lap) % palette.length]!
}

function Badge(props: { text: string; color: RGBA; ink: RGBA }) {
  return (
    <text fg={props.ink} bg={props.color} attributes={TextAttributes.BOLD} wrapMode="none">
      {` ${props.text} `}
    </text>
  )
}

// What the Council receives once every invited Orchestrator answered: one card per member.
export function CouncilResultsCard(props: { results: Federation.CouncilResults }) {
  const theme = useTheme()
  const { currentSyntax: syntax } = useThemes()
  return (
    <box flexDirection="column" gap={1} paddingLeft={3} paddingTop={1} paddingBottom={1} flexShrink={0}>
      <box flexDirection="row" gap={1}>
        <Badge text={tr("◆ Council")} color={theme.hue.accent[200]} ink={theme.background.base} />
        <text fg={theme.text.base} attributes={TextAttributes.BOLD} wrapMode="none" truncate>
          {props.results.subject ?? props.results.group}
        </text>
        <text fg={theme.text.muted} wrapMode="none">
          {tr("{count} answer(s)", { count: props.results.proposals.length })}
        </text>
      </box>
      <For each={props.results.proposals}>
        {(proposal) => {
          const color = () => callsignColor(theme, proposal.callsign)
          return (
            <box
              border={["left"]}
              borderColor={color()}
              customBorderChars={SplitBorder.customBorderChars}
              paddingLeft={2}
              flexDirection="column"
            >
              <box flexDirection="row" gap={1}>
                <Badge text={proposal.callsign ?? proposal.name} color={color()} ink={theme.background.base} />
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

// Replies the assistant offered with <reply-options>: each is a button that sends its text.
// They stay on screen after use but turn dim so the chat shows which way the operator went.
export function ReplyOptions(props: { options: ReadonlyArray<Federation.ReplyOption>; settled?: boolean }) {
  const theme = useTheme()
  const send = useQuickSend()
  const [hover, setHover] = createSignal<number>()
  const [chosen, setChosen] = createSignal<number>()
  const locked = () => props.settled === true || chosen() !== undefined
  return (
    <box flexDirection="column" paddingLeft={3} paddingTop={1} flexShrink={0} position="relative">
      {/* A branch from the conversation's nerve: interactive answers hang off it like the messages. */}
      <text position="absolute" left={1} top={1} fg={neuralPalette(theme).signal} selectable={false}>
        ├─
      </text>
      <text fg={theme.text.muted} wrapMode="none">
        {locked() ? tr("Answer chosen") : tr("Pick an answer — a click sends it to the chat")}
      </text>
      <box flexDirection="row" gap={1} flexWrap="wrap" paddingTop={1}>
        <For each={props.options}>
          {(option, index) => {
            const hot = () => !locked() && hover() === index()
            const picked = () => chosen() === index()
            return (
              <box
                onMouseOver={() => setHover(index())}
                onMouseOut={() => setHover(undefined)}
                onMouseUp={() => {
                  if (locked()) return
                  setChosen(index())
                  send(option.send)
                }}
              >
                <text
                  wrapMode="none"
                  fg={hot() ? theme.background.base : picked() ? theme.text.feedback.success.base : theme.hue.accent[200]}
                  bg={hot() ? theme.hue.accent[200] : theme.background.raised.base}
                  attributes={picked() ? TextAttributes.BOLD : undefined}
                >
                  {` ${picked() ? "✓" : "▸"} ${option.label} `}
                </text>
              </box>
            )
          }}
        </For>
      </box>
    </box>
  )
}

// Above the prompt of a Society chat: every member with its call sign. A click puts @Name into the prompt.
export function SocietyRoster(props: { sessionID: string }) {
  const theme = useTheme()
  const data = useData()
  const client = useClient()
  const projects = useProjects()
  const promptRef = usePromptRef()
  const marker = createMemo(() => Federation.groupSupervisor(data.session.get(props.sessionID)?.metadata))
  const [groups, { refetch }] = createResource(
    () => marker()?.groupName,
    () => client.api.orchestra.group.list().catch(() => []),
  )
  onMount(() => {
    const timer = setInterval(() => void refetch(), 5000)
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
    }))
  })
  const [hover, setHover] = createSignal<string>()
  const mention = (callsign: string) => {
    const prompt = promptRef.current
    if (!prompt) return
    const text = prompt.current.text
    prompt.set({ ...prompt.current, text: `${text}${text && !text.endsWith(" ") ? " " : ""}@${callsign} ` })
    prompt.focus()
  }
  return (
    <Show when={members().length > 0}>
      <box flexDirection="row" gap={1} flexWrap="wrap" paddingLeft={1} paddingBottom={1} flexShrink={0}>
        <text fg={theme.text.muted} wrapMode="none">
          {tr("Society")}
        </text>
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
                  {`${member.online ? "●" : "○"} @${member.callsign} · ${member.name}`}
                </text>
              </box>
            )
          }}
        </For>
        <text fg={theme.text.muted} wrapMode="none">
          {tr("· @all — everyone")}
        </text>
      </box>
    </Show>
  )
}
