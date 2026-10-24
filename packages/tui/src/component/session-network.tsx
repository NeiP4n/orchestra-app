import type { RGBA } from "@opentui/core"
import { createMemo, createSignal, Show } from "solid-js"
import { useData } from "../context/data"
import { useTheme } from "../context/theme"
import { useT } from "../util/i18n"
import { NeuronDot, NeuronField, neuralPalette, useMotion } from "./neural"

// One Session's part of the network, for the chat screen. The Session and its workers each own a
// labelled hub neuron; every tool call bridges a hub to that tool's neuron and shows how it ended.
function useSessionScope(sessionID: () => string) {
  const data = useData()
  const t = useT()
  const workers = createMemo(() => data.session.list().filter((session) => session.parentID === sessionID()))
  const scope = createMemo(() => [sessionID(), ...workers().map((session) => session.id)])
  const names = createMemo(() => ({
    [sessionID()]: t("this session"),
    ...Object.fromEntries(workers().map((session) => [session.id, (session.title || "worker").slice(0, 14)])),
  }))
  const running = () => scope().some((id) => data.session.status(id) === "running")
  return { workers, scope, names, running }
}

// The header and the status row: what the agent is doing now, and how its tool calls went.
export function SessionNetwork(props: { sessionID: string }) {
  const data = useData()
  const theme = useTheme()
  const t = useT()
  const palette = () => neuralPalette(theme)
  const session = useSessionScope(() => props.sessionID)
  const tools = createMemo(() =>
    session
      .scope()
      .flatMap((id) => data.session.message.list(id))
      .flatMap((message) => (message.type === "assistant" ? message.content : []))
      .filter((part) => part.type === "tool"),
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
    if (!session.running()) return { text: t("quiet"), lit: false }
    const part = data.session.message
      .list(props.sessionID)
      .findLast((message) => message.type === "assistant")
      ?.content.at(-1)
    if (part?.type === "reasoning") return { text: t("thinking"), lit: true }
    return { text: t("writing"), lit: true }
  })
  const busyWorkers = () => session.workers().filter((worker) => data.session.status(worker.id) === "running").length

  return (
    <box flexShrink={0} gap={0}>
      <box flexDirection="row" gap={1} flexShrink={0}>
        <NeuronDot energy={session.running() ? 0.35 : 0.04} session={session.scope()} />
        <text fg={theme.text.muted} wrapMode="none" flexGrow={1}>
          {t("Session network")}
        </text>
        <Show when={session.workers().length > 0}>
          <text fg={busyWorkers() > 0 ? palette().signal : theme.text.muted} wrapMode="none">
            {t("{count} workers", { count: `${busyWorkers()}/${session.workers().length}` })}
          </text>
        </Show>
      </box>
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

// The Session's network itself, sized by whoever has room for it. It fills otherwise empty room,
// so with motion off it leaves the room empty rather than drawing a frozen mesh.
export function SessionNetworkField(props: { sessionID: string; backdrop: RGBA; height: number }) {
  const session = useSessionScope(() => props.sessionID)
  const motion = useMotion()
  return (
    <Show when={motion()}>
      <NeuronField
        width="100%"
        height={props.height}
        energy={session.running() ? 0.35 : 0.03}
        seed={13}
        backdrop={props.backdrop}
        session={session.scope()}
        names={session.names()}
      />
    </Show>
  )
}

// The whole network: every Session's hub, labelled with its title, so the chat screen shows which
// other conversations are working right now.
export function AllSessionsField(props: { currentID?: string; backdrop: RGBA; height: number }) {
  const data = useData()
  const t = useT()
  const names = createMemo(() =>
    Object.fromEntries(
      data.session
        .list()
        .filter((session) => !session.parentID)
        .toSorted((left, right) => {
          const busy =
            Number(data.session.status(right.id) === "running") - Number(data.session.status(left.id) === "running")
          return busy || right.time.updated - left.time.updated
        })
        .slice(0, 6)
        .map((session) => [
          session.id,
          session.id === props.currentID ? t("this session") : (session.title || "session").slice(0, 14),
        ]),
    ),
  )
  const running = () => data.session.list().some((session) => data.session.status(session.id) === "running")
  const motion = useMotion()
  return (
    <Show when={motion()}>
      <NeuronField
        width="100%"
        height={props.height}
        energy={running() ? 0.3 : 0.03}
        seed={21}
        backdrop={props.backdrop}
        names={names()}
      />
    </Show>
  )
}

// How many rows a scroll area leaves empty below its content, so a network can fill them.
export function useEmptyRoom() {
  const [area, setArea] = createSignal(0)
  const [content, setContent] = createSignal(0)
  return {
    room: () => Math.max(0, area() - content() - 1),
    area: setArea,
    content: setContent,
  }
}
