import { Prompt, type PromptRef } from "../component/prompt"
import { createEffect, createMemo, createSignal, For, onMount, Show, untrack } from "solid-js"
import { SessionOwnerMetadataKey } from "@orchestra/schema/orchestra"
import { Logo } from "../component/logo"
import { useArgs } from "../context/args"
import { useRoute, useRouteData } from "../context/route"
import { usePromptRef } from "../context/prompt"
import { useLocal } from "../context/local"
import { useEditorContext } from "../context/editor"
import { useData } from "../context/data"
import { useLocation } from "../context/location"
import { useProjects } from "../context/projects"
import { useToast } from "../ui/toast"
import { errorMessage } from "../util/error"
import { FormPrompt } from "./session/form"
import { Slot } from "../plugin/render"
import { useTerminalDimensions } from "@opentui/solid"
import { useTheme } from "../context/theme"
import { useUpdateNotification } from "../context/update-notification"
import { useExit } from "../context/exit"
import { FadeInText } from "../component/fade-in-text"
import { NeuralCard, NeuronDot, NeuronField, neuralPalette, useNeuralEnergy } from "../component/neural"
import { useNeuralActivity } from "../component/neural-activity"
import { useT } from "../util/i18n"
import { Locale } from "../util/locale"
import { useCompactLayout } from "../ui/compact-layout"
import { homeContentWidth } from "../ui/layout"

let once = false
const placeholder = {
  normal: ["Fix a TODO in the codebase", "What is the tech stack of this project?", "Fix broken tests"],
  shell: ["ls -la", "git status", "pwd"],
}

export function Home() {
  const route = useRouteData("home")
  const promptRef = usePromptRef()
  const [ref, setRef] = createSignal<PromptRef | undefined>()
  const args = useArgs()
  const local = useLocal()
  const editor = useEditorContext()
  const data = useData()
  const location = useLocation()
  const projects = useProjects()
  const toast = useToast()
  const dimensions = useTerminalDimensions()
  const [logoWidth, setLogoWidth] = createSignal(0)
  const energy = useNeuralEnergy()
  const level = useCompactLayout().density
  // The stage is the room Home actually has between the side panels; the column follows it.
  const [stage, setStage] = createSignal({ width: dimensions().width, height: dimensions().height })
  const column = () => homeContentWidth(stage().width)
  const theme = useTheme()
  // Typing excites the network: every change of the prompt's length fires one neuron.
  const keystrokes = createMemo(() => ref()?.current.text.length ?? 0)
  // Global MCP elicitations can arrive without a session route, so keep them reachable from Home.
  const currentLocation = () => route.location ?? data.location.default()
  const forms = createMemo(() => data.session.form.list("global", currentLocation()) ?? [])
  let sent = false

  // Track only the route location and (when absent) the default location; location.set
  // reads other signals internally and tracking them would re-assert the route location
  // after the user overrides it with /cd.
  createEffect(() => {
    const target = currentLocation()
    untrack(() => location.set(target))
  })

  onMount(() => {
    editor.clearSelection()
  })

  const bind = (r: PromptRef | undefined) => {
    setRef(r)
    promptRef.set(r)
    // The project tree's "+ New session" click leaves focus on its row. When Home
    // mounts for that route, move keyboard focus to the newly created prompt.
    if (route.project && r) queueMicrotask(() => r.focus())
    if (once || !r || route.prompt || !args.prompt) return
    r.set({ text: args.prompt, files: [], agents: [], pasted: [] })
    once = true
  }

  createEffect(() => {
    const composer = ref()
    const prompt = route.prompt
    if (!composer || prompt?.text === undefined) return
    untrack(() => composer.set(prompt))
  })

  // Wait for everything submit needs before auto-submitting --prompt; it runs once.
  createEffect(() => {
    const r = ref()
    if (sent) return
    if (!r) return
    if (!local.model.ready || !local.model.catalogReady) return
    if (!local.agent.current() || !local.model.current()) return
    if (!args.prompt) return
    if (r.current.text !== args.prompt) return
    sent = true
    r.submit()
  })

  return (
    <>
      <box
        flexGrow={1}
        alignItems="center"
        position="relative"
        paddingLeft={dimensions().width < 44 ? 1 : 2}
        paddingRight={dimensions().width < 44 ? 1 : 2}
        onSizeChange={function () {
          setStage({ width: this.width, height: this.height })
        }}
      >
        {/* The network fills the whole stage behind the logo and the prompt and speeds up while agents work. */}
        <NeuronField
          position="absolute"
          left={0}
          top={0}
          width="100%"
          height="100%"
          zIndex={0}
          energy={energy()}
          stimulus={keystrokes()}
        />
        <box flexGrow={1} minHeight={0} />
        <box height={level() === "spacious" ? 3 : level() === "tiny" ? 0 : 2} minHeight={0} flexShrink={1} />
        {/* The logo sits in a clear window cut out of the network so its letters stay crisp. */}
        <box
          flexShrink={0}
          zIndex={1}
          paddingLeft={2}
          paddingRight={2}
          backgroundColor={theme.background.base}
          onSizeChange={function () {
            setLogoWidth(this.width)
          }}
        >
          <Logo />
        </box>
        <box height={1} flexShrink={0} />
        <BrainStatus energy={energy()} width={column()} />
        <UpdateNotification width={logoWidth()} />
        <box width="100%" maxWidth={column()} zIndex={1000} paddingTop={1} flexShrink={0} position="relative">
          <Prompt
            ref={bind}
            metadata={route.project ? { [SessionOwnerMetadataKey]: { projectID: route.project } } : undefined}
            placeholders={placeholder}
            disabled={forms().length > 0}
            onCreate={(sessionID, request) => {
              // Opened from a project's "+ New session": it stays with that project even
              // when other projects share the directory.
              if (!route.project) return
              projects
                .claim(sessionID, route.project, request)
                .catch((error: unknown) => toast.show({ message: errorMessage(error), variant: "error" }))
            }}
          />
        </box>
        <RecentSessions width={column()} height={stage().height} />
        <box flexGrow={1} minHeight={0} />
      </box>
      <box width="100%" flexShrink={0}>
        <Slot path="home.footer" />
      </box>
      <Show when={forms()[0]?.id} keyed>
        {(_) => {
          const form = forms()[0]
          return form ? (
            <box position="absolute" zIndex={2000} left={0} right={0} bottom={1} paddingLeft={2} paddingRight={2}>
              <box width="100%">
                <FormPrompt form={form} />
              </box>
            </box>
          ) : null
        }}
      </Show>
    </>
  )
}

// One line under the logo that reads the network's state: a breathing neuron, then what is
// connected and how many agents are thinking right now.
function BrainStatus(props: { energy: number; width: number }) {
  const theme = useTheme()
  const t = useT()
  const data = useData()
  const projects = useProjects()
  const palette = () => neuralPalette(theme)
  const sessions = createMemo(() => data.session.list().filter((session) => !session.parentID))
  const thinking = createMemo(() => sessions().filter((session) => data.session.status(session.id) === "running").length)
  const activity = useNeuralActivity()
  return (
    <box flexDirection="row" flexShrink={0} gap={1} zIndex={1} paddingLeft={1} paddingRight={1} backgroundColor={theme.background.base}>
      <NeuronDot energy={props.energy} />
      <text fg={thinking() > 0 ? palette().signal : theme.text.muted} wrapMode="none">
        {thinking() > 0 ? t("{count} agents thinking", { count: thinking() }) : t("network ready")}
      </text>
      {/* The newest action the network lit up, such as a tool's name, until it cools down. */}
      <Show when={thinking() > 0 && activity.latest()}>
        {(latest) => (
          <text fg={palette().spark} wrapMode="none">
            {`▸ ${latest()}`}
          </text>
        )}
      </Show>
      {/* The counts are context, so a narrow column keeps only the network's state. */}
      <Show when={props.width >= 56}>
        <text fg={palette().synapse} wrapMode="none">
          ·
        </text>
        <text fg={theme.text.muted} wrapMode="none">
          {t("{count} projects", { count: projects.list().length })}
        </text>
        <text fg={palette().synapse} wrapMode="none">
          ·
        </text>
        <text fg={theme.text.muted} wrapMode="none">
          {t("{count} sessions", { count: sessions().length })}
        </text>
      </Show>
    </box>
  )
}

// The last few conversations as cards under the prompt: one click picks up where you left off.
function RecentSessions(props: { width: number; height: number }) {
  const theme = useTheme()
  const t = useT()
  const data = useData()
  const route = useRoute()
  const palette = () => neuralPalette(theme)
  // A card needs about 26 columns for a readable title; a tall window also gets a second row.
  const perRow = () => Math.max(0, Math.min(4, Math.floor((props.width + 1) / 27)))
  const rows = () => (props.height >= 44 ? 2 : props.height >= 26 ? 1 : 0)
  const count = () => perRow() * rows()
  const recent = createMemo(() =>
    data.session
      .list()
      .filter((session) => !session.parentID)
      .toSorted((left, right) => right.time.updated - left.time.updated)
      .slice(0, count()),
  )
  return (
    <Show when={recent().length > 0 && count() > 0}>
      <box width="100%" maxWidth={props.width} flexShrink={0} paddingTop={1} zIndex={1} gap={0}>
        <text fg={theme.text.muted} wrapMode="none" paddingLeft={1}>
          {t("Continue")}
        </text>
        <box flexDirection="row" flexWrap="wrap" columnGap={1} width="100%">
          <For each={recent()}>
            {(session) => (
              <NeuralCard
                flexGrow={1}
                flexShrink={1}
                width={`${Math.floor(100 / Math.min(perRow(), recent().length)) - 1}%`}
                onClick={() => route.navigate({ type: "session", sessionID: session.id })}
                footer={Locale.time(session.time.updated)}
              >
                <box flexDirection="row" gap={1}>
                  <text
                    flexShrink={0}
                    fg={data.session.status(session.id) === "running" ? palette().signal : palette().synapse}
                  >
                    {data.session.status(session.id) === "running" ? "◉" : "●"}
                  </text>
                  <text fg={theme.text.base} wrapMode="none" truncate>
                    {session.title || t("Untitled")}
                  </text>
                </box>
              </NeuralCard>
            )}
          </For>
        </box>
      </box>
    </Show>
  )
}

function UpdateNotification(props: { width: number }) {
  const update = useUpdateNotification()
  const exit = useExit()
  const theme = useTheme()
  const [hovered, setHovered] = createSignal(false)
  const backdrop = () => (hovered() ? theme.background.action.primary.hovered : theme.background.base)
  createEffect(() => {
    update.notification()
    setHovered(false)
  })

  return (
    <Show when={update.notification()} keyed>
      {(state) => {
        const remote = state.source === "server" && state.remote
        return (
          <Show when={!remote || state.type === "available"}>
            <box
              flexShrink={0}
              flexDirection="row"
              justifyContent="center"
              width={props.width}
              maxWidth="100%"
              gap={1}
              backgroundColor={hovered() ? theme.background.action.primary.hovered : undefined}
              onMouseOver={() => setHovered(true)}
              onMouseOut={() => setHovered(false)}
              onMouseUp={() => {
                if (remote) return update.dismiss()
                if (state.type === "installed") return exit()
                update.open?.("notification")
              }}
            >
              <FadeInText fg={theme.text.muted} backdrop={backdrop()}>
                <Show when={!remote}>
                  <span style={{ fg: theme.text.action.primary.selected }}>
                    {state.type === "installed" ? "/exit" : "/upgrade"}
                  </span>
                </Show>
                {remote
                  ? "remote server update available"
                  : state.type === "installed"
                    ? ` restart to use v${state.version}`
                    : ` to install v${state.version}`}
              </FadeInText>
            </box>
          </Show>
        )
      }}
    </Show>
  )
}
