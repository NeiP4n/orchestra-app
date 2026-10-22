import { createMemo, createResource, Show } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import { Orchestra } from "@orchestra/schema/orchestra"
import { useClient } from "../context/client"
import { useData } from "../context/data"
import { useLocation } from "../context/location"
import { useProjects } from "../context/projects"
import { useRoute } from "../context/route"
import { useTheme } from "../context/theme"
import { useT } from "../util/i18n"
import { Sidebar } from "../routes/session/sidebar"
import { HoverAction } from "./hover-action"
import { NeuralCard, NeuronDot, NeuronField, neuralPalette, useNeuralEnergy } from "./neural"

export function HomeProjectPanel(props: {
  width: number
  collapsed?: boolean
  onHide?: () => void
  onShow?: () => void
}) {
  const theme = useTheme()
  const t = useT()
  const route = useRoute()
  const client = useClient()
  const data = useData()
  const location = useLocation()
  const projects = useProjects()

  const currentDirectory = () =>
    location.current?.directory ?? location.ref?.directory ?? data.location.default().directory

  const project = createMemo(() => {
    const all = projects.list()
    const currentRoute = route.data
    if (currentRoute.type === "home" && currentRoute.project) {
      const selected = all.find((item) => item.id === currentRoute.project)
      if (selected) return selected
    }
    const owner = Orchestra.ownerOf(all, currentDirectory())
    return owner ?? (all.length === 1 ? all[0] : undefined)
  })

  // Use the project's existing session roster; never create a session just to populate the panel.
  const [roster] = createResource(
    () => project()?.id,
    async (projectID) => {
      try {
        const result = await client.api.orchestra.project.sessions({ projectID })
        if (project()?.id !== projectID) return []
        result.data.forEach((session) => data.session.remember(session))
        return result.data
      } catch {
        return []
      }
    },
  )
  const palette = () => neuralPalette(theme)
  const energy = useNeuralEnergy()
  const dimensions = useTerminalDimensions()
  // The network window grows on tall screens and disappears on short ones.
  const fieldHeight = () => (dimensions().height >= 56 ? 12 : dimensions().height >= 44 ? 8 : dimensions().height >= 32 ? 5 : 0)
  const sessions = createMemo(() => data.session.list().filter((session) => !session.parentID))
  const thinking = createMemo(() => sessions().filter((session) => data.session.status(session.id) === "running").length)
  const energyLabel = () => `${"▮".repeat(Math.round(energy() * 5))}${"▯".repeat(5 - Math.round(energy() * 5))}`
  const mainSessionID = () => {
    const main = project()?.main
    return main && roster()?.some((session) => session.id === main) ? main : undefined
  }

  return (
    <Show
      when={!props.collapsed}
      fallback={
        <box
          width={props.width}
          height="100%"
          flexShrink={0}
          backgroundColor={theme.background.raised.base}
          border={["left"]}
          borderColor={theme.border.base}
          paddingTop={1}
        >
          <box
            id="home-project-panel-show"
            width={3}
            height={1}
            flexShrink={0}
            alignItems="center"
            justifyContent="center"
            backgroundColor={theme.background.raised.base}
            onMouseDown={(event) => event.stopPropagation()}
            onMouseUp={(event) => {
              event.stopPropagation()
              props.onShow?.()
            }}
          >
            <text fg={theme.text.action.primary.base}>‹</text>
          </box>
        </box>
      }
    >
      <Show
        when={mainSessionID()}
        fallback={
          <box
            width={props.width}
            height="100%"
            position="relative"
            flexShrink={0}
            minWidth={0}
            minHeight={0}
            flexDirection="column"
            padding={1}
            gap={1}
            backgroundColor={theme.background.raised.base}
            border={["left"]}
            borderColor={theme.border.base}
          >
            <box flexDirection="row" flexShrink={0} gap={1}>
              <NeuronDot energy={energy()} />
              <text fg={theme.text.base} wrapMode="none" truncate flexGrow={1}>
                <b>{t("Project overview")}</b>
              </text>
              <Show when={props.onHide}>
                <HoverAction id="home-project-panel-hide" paddingLeft={1} paddingRight={1} onClick={() => props.onHide?.()}>
                  <text fg={palette().synapse} wrapMode="none">
                    ›
                  </text>
                </HoverAction>
              </Show>
            </box>
            <NeuralCard title={project()?.name ?? t("Current directory")} gap={0}>
              <text fg={theme.text.muted} wrapMode="word">
                {project()?.directory ?? currentDirectory()}
              </text>
              <text fg={roster.loading ? palette().signal : theme.text.muted} wrapMode="word">
                {roster.loading
                  ? t("Loading project session…")
                  : t("No orchestrator session is available for this project yet.")}
              </text>
            </NeuralCard>
            {/* A small window onto the network: it fires faster as more agents work. */}
            {/* Cards drop from the bottom as the window gets shorter; the overview always stays. */}
            <Show when={dimensions().height >= 26}>
            <NeuralCard title={t("Network")} footer={energyLabel()}>
              <Show when={fieldHeight() > 0}>
                <NeuronField
                  width="100%"
                  height={fieldHeight()}
                  energy={energy()}
                  seed={11}
                  backdrop={theme.background.raised.base}
                />
              </Show>
              <Stat label={t("Sessions")} value={String(sessions().length)} />
              <Stat label={t("Thinking now")} value={String(thinking())} lit={thinking() > 0} />
              <Stat
                label={t("Server")}
                value={client.connection.status() === "connected" ? t("Connected") : client.connection.status()}
                lit={client.connection.status() === "connected"}
              />
            </NeuralCard>
            </Show>
            <Show when={dimensions().height >= 40}>
            <NeuralCard title={t("Shortcuts")}>
              <Stat label={t("commands")} value="ctrl+p" />
              <Stat label={t("agents")} value="shift+tab" />
              <Stat label={t("slash commands")} value="/" />
              <Stat label={t("files and agents")} value="@" />
              <Stat label={t("shell")} value="!" />
            </NeuralCard>
            </Show>
          </box>
        }
      >
        {(sessionID) => (
          <Sidebar sessionID={sessionID()} width={props.width} borderLeft onHide={props.onHide} />
        )}
      </Show>
    </Show>
  )
}

// A label on the left, its value on the right, the value lit when it signals activity.
function Stat(props: { label: string; value: string; lit?: boolean }) {
  const theme = useTheme()
  return (
    <box flexDirection="row" gap={1}>
      <text fg={theme.text.muted} wrapMode="none" truncate flexGrow={1}>
        {props.label}
      </text>
      <text fg={props.lit ? neuralPalette(theme).signal : theme.text.base} wrapMode="none">
        {props.value}
      </text>
    </box>
  )
}
