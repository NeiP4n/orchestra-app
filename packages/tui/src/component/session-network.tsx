import type { RGBA } from "@opentui/core"
import { createMemo, Show } from "solid-js"
import { useData } from "../context/data"
import { useTheme } from "../context/theme"
import { useT } from "../util/i18n"
import { NeuronDot, NeuronField, neuralPalette } from "./neural"

// A window onto one Session's part of the network, for the chat sidebar. The Session and its
// workers each own a hub neuron (workers are labelled); every tool call bridges a hub to that
// tool's neuron and shows how it ended. Below it one row reads what the agent is doing now and
// how its tool calls went: running, succeeded, failed.
export function SessionNetwork(props: { sessionID: string; backdrop: RGBA; height: number }) {
  const data = useData()
  const theme = useTheme()
  const t = useT()
  const palette = () => neuralPalette(theme)
  const workers = createMemo(() => data.session.list().filter((session) => session.parentID === props.sessionID))
  const scope = createMemo(() => [props.sessionID, ...workers().map((session) => session.id)])
  const names = createMemo(() =>
    Object.fromEntries(workers().map((session) => [session.id, (session.title || "worker").slice(0, 14)])),
  )
  const running = () => scope().some((id) => data.session.status(id) === "running")
  const assistant = createMemo(() =>
    scope()
      .flatMap((id) => data.session.message.list(id))
      .flatMap((message) => (message.type === "assistant" ? [message] : [])),
  )
  const tools = createMemo(() =>
    assistant().flatMap((message) => message.content.filter((part) => part.type === "tool")),
  )
  const tally = createMemo(() => ({
    running: tools().filter((tool) => tool.state.status === "running" || tool.state.status === "streaming"),
    done: tools().filter((tool) => tool.state.status === "completed").length,
    failed: tools().filter((tool) => tool.state.status === "error").length,
  }))
  // What the agent is doing now, from the newest part of its own newest answer.
  const doing = createMemo(() => {
    const active = tally().running.at(-1)
    if (active) return { text: `▸ ${active.name}`, lit: true }
    if (!running()) return { text: t("quiet"), lit: false }
    const part = data.session.message
      .list(props.sessionID)
      .findLast((message) => message.type === "assistant")
      ?.content.at(-1)
    if (part?.type === "reasoning") return { text: t("thinking"), lit: true }
    return { text: t("writing"), lit: true }
  })
  const busyWorkers = () => workers().filter((session) => data.session.status(session.id) === "running").length

  return (
    <box flexShrink={0} gap={0}>
      <box flexDirection="row" gap={1} flexShrink={0}>
        <NeuronDot energy={running() ? 0.35 : 0.04} session={scope()} />
        <text fg={theme.text.muted} wrapMode="none" flexGrow={1}>
          {t("Session network")}
        </text>
        <Show when={workers().length > 0}>
          <text fg={busyWorkers() > 0 ? palette().signal : theme.text.muted} wrapMode="none">
            {t("{count} workers", { count: `${busyWorkers()}/${workers().length}` })}
          </text>
        </Show>
      </box>
      <NeuronField
        width="100%"
        height={props.height}
        energy={running() ? 0.35 : 0.03}
        seed={13}
        backdrop={props.backdrop}
        session={scope()}
        names={names()}
      />
      <box flexDirection="row" gap={1} flexShrink={0}>
        <text fg={doing().lit ? palette().spark : theme.text.muted} wrapMode="none" flexGrow={1}>
          {doing().text}
        </text>
        <Show when={tally().running.length > 0}>
          <text fg={palette().signal} wrapMode="none">
            {`▸${tally().running.length}`}
          </text>
        </Show>
        <text fg={tally().done > 0 ? palette().done : theme.text.muted} wrapMode="none">
          {`✓${tally().done}`}
        </text>
        <text fg={tally().failed > 0 ? palette().fail : theme.text.muted} wrapMode="none">
          {`✗${tally().failed}`}
        </text>
      </box>
    </box>
  )
}
