import { ImageRenderable, NativeImage, TextAttributes, type InputRenderable } from "@opentui/core"
import { extend, useRenderer } from "@opentui/solid"
import { createEffect, createSignal, For, onCleanup, Show } from "solid-js"
import { useTheme } from "../context/theme"
import { errorMessage } from "../util/error"
import { useT } from "../util/i18n"
import * as BrowserRuntime from "../util/browser-runtime"

declare module "@opentui/solid" {
  interface OpenTUIComponents {
    browserImage: typeof ImageRenderable
  }
}

extend({ browserImage: ImageRenderable })

// The live picture is capped so a big terminal does not make Chrome render and ship huge frames.
const MAX_WIDTH = 1600
const MAX_HEIGHT = 1000
// At most this many frames a second are decoded and drawn; Chrome is acknowledged per frame anyway.
const FRAME_GAP_MS = 120

// The text view of one browser session: its page address, title and the page's visible text. It reads
// the page; pixels and clicking come later. Chrome starts only when the operator opens the page.
export function BrowserPane(props: {
  sessionID: string
  name: string
  chatHidden: boolean
  canShowChat: boolean
  onToggleChat: () => void
}) {
  const theme = useTheme()
  const t = useT()
  const [state, setState] = createSignal<"idle" | "busy" | "ready">(
    BrowserRuntime.isOpen(props.sessionID) ? "ready" : "idle",
  )
  const [page, setPage] = createSignal({ url: "", title: "", text: "" })
  const [failure, setFailure] = createSignal<string>()
  // The screen is the page streamed as pictures (kitty or sixel graphics when the terminal has them,
  // colored half-blocks otherwise); the text view stays as the plain fallback.
  const [view, setView] = createSignal<"screen" | "text">("screen")
  const renderer = useRenderer()
  const [size, setSize] = createSignal<{ cols: number; rows: number }>()
  let picture: ImageRenderable | undefined
  let lastFrame = 0
  let address: InputRenderable | undefined
  let disposed = false
  onCleanup(() => (disposed = true))

  const run = async (work: () => Promise<void>) => {
    setFailure(undefined)
    setState("busy")
    try {
      await work()
      if (!disposed) setState("ready")
    } catch (error) {
      // Chrome did not start: back to the Open Chrome screen with the reason.
      if (disposed) return
      setFailure(errorMessage(error))
      setState("idle")
    }
  }

  // Lay the page out for the pane, and again whenever the pane changes (window resize, chat hidden).
  createEffect(() => {
    const area = size()
    if (state() !== "ready" || view() !== "screen" || !area) return
    const resolution = renderer.resolution
    const cellWidth = resolution ? resolution.width / renderer.width : 8
    const cellHeight = resolution ? resolution.height / renderer.height : 16
    const width = Math.min(MAX_WIDTH, Math.max(200, Math.round(area.cols * cellWidth)))
    const height = Math.min(MAX_HEIGHT, Math.max(120, Math.round(area.rows * cellHeight)))
    const timer = setTimeout(() => {
      void BrowserRuntime.watch(props.sessionID, { width, height }, (frame) => {
        const now = Date.now()
        if (disposed || !picture || picture.isDestroyed || now - lastFrame < FRAME_GAP_MS) return
        lastFrame = now
        try {
          picture.source = NativeImage.decode(Buffer.from(frame.data, "base64"))
        } catch {
          // A frame that does not decode is skipped; the next one replaces it.
        }
      }).catch((error) => !disposed && setFailure(errorMessage(error)))
    }, 200)
    onCleanup(() => clearTimeout(timer))
  })
  onCleanup(() => BrowserRuntime.unwatch(props.sessionID))

  const open = () => run(async () => void (await BrowserRuntime.open(props.sessionID)))

  // The tab strip and address bar mirror Chrome's own tabs: titles and addresses are read from Chrome.
  const [tabs, setTabs] = createSignal<Array<{ id: string; title: string; url: string; active: boolean }>>([])
  const active = () => tabs().find((tab) => tab.active)
  const refresh = async () => {
    try {
      const list = await BrowserRuntime.tabs(props.sessionID)
      if (disposed) return
      setTabs(list)
      if (view() === "text") setPage(await BrowserRuntime.read(props.sessionID))
    } catch {
      // A poll that fails (Chrome closing, a tab switching) is retried on the next tick.
    }
  }
  createEffect(() => {
    if (state() === "idle") return
    void refresh()
    const timer = setInterval(() => void refresh(), 1500)
    onCleanup(() => clearInterval(timer))
  })
  // The address bar shows the active tab's address unless the operator is typing in it.
  createEffect(() => {
    const url = active()?.url ?? ""
    if (address && !address.isDestroyed && !address.focused && address.value !== url) address.value = url
  })

  const act = (work: () => Promise<unknown>) => {
    setFailure(undefined)
    void work()
      .then(() => new Promise((done) => setTimeout(done, 300)))
      .then(refresh)
      .catch((error) => !disposed && setFailure(errorMessage(error)))
  }
  const go = (value: string) => act(() => BrowserRuntime.go(props.sessionID, value))
  const stop = () => {
    BrowserRuntime.close(props.sessionID)
    setPage({ url: "", title: "", text: "" })
    setTabs([])
    setState("idle")
  }

  const Action = (action: { label: string; onClick: () => void }) => (
    <box paddingLeft={1} paddingRight={1} onMouseUp={action.onClick}>
      <text fg={theme.text.action.primary.base}>{action.label}</text>
    </box>
  )

  // One tab, drawn like Chrome's: the active one is raised, each has its title and a close mark.
  const TabButton = (tab: { id: string; title: string; url: string; active: boolean }) => (
    <box
      flexDirection="row"
      flexShrink={1}
      minWidth={8}
      maxWidth={24}
      paddingLeft={1}
      paddingRight={1}
      gap={1}
      backgroundColor={tab.active ? theme.background.raised.high : theme.background.base}
      onMouseUp={() => act(() => BrowserRuntime.selectTab(props.sessionID, tab.id))}
    >
      <text
        flexGrow={1}
        flexShrink={1}
        minWidth={0}
        wrapMode="none"
        truncate
        fg={tab.active ? theme.text.base : theme.text.muted}
        attributes={tab.active ? TextAttributes.BOLD : undefined}
      >
        {tab.title || tab.url.replace(/^https?:\/\//, "") || t("New tab")}
      </text>
      <text
        flexShrink={0}
        fg={theme.text.muted}
        onMouseUp={(event: { stopPropagation: () => void }) => {
          event.stopPropagation()
          act(() => BrowserRuntime.closeTab(props.sessionID, tab.id))
        }}
      >
        {"×"}
      </text>
    </box>
  )

  return (
    <box flexGrow={1} minWidth={0} minHeight={0} flexDirection="column" paddingLeft={1} paddingRight={1}>
      <Show
        when={state() !== "idle"}
        fallback={
          <box flexGrow={1} alignItems="center" justifyContent="center" flexDirection="column" gap={1}>
            <text fg={theme.text.base} attributes={TextAttributes.BOLD}>{`${t("Browser")} · ${props.name}`}</text>
            <text fg={theme.text.muted}>{t("This session runs its own Google Chrome with a separate profile.")}</text>
            <Action label={`▶ ${t("Open Chrome")}`} onClick={() => void open()} />
            <Show when={props.canShowChat}>
              <Action label={props.chatHidden ? t("Show chat") : t("Hide chat")} onClick={props.onToggleChat} />
            </Show>
            <Show when={failure()}>
              <text fg={theme.text.feedback.error.base}>{failure()}</text>
            </Show>
          </box>
        }
      >
        <box flexDirection="row" flexShrink={0} gap={0}>
          <box flexDirection="row" flexGrow={1} flexShrink={1} minWidth={0}>
            <For each={tabs()}>{(tab) => <TabButton {...tab} />}</For>
            <Action label="+" onClick={() => act(() => BrowserRuntime.newTab(props.sessionID))} />
          </box>
          <Show when={props.canShowChat}>
            <Action label={props.chatHidden ? t("Show chat") : t("Hide chat")} onClick={props.onToggleChat} />
          </Show>
          <Action
            label={view() === "screen" ? t("Text") : t("Screen")}
            onClick={() => {
              if (view() === "screen") BrowserRuntime.unwatch(props.sessionID)
              setView(view() === "screen" ? "text" : "screen")
            }}
          />
          <Action label={t("Close browser")} onClick={stop} />
        </box>
        <box flexDirection="row" flexShrink={0} gap={1} backgroundColor={theme.background.raised.high}>
          <Action label="◀" onClick={() => act(() => BrowserRuntime.history(props.sessionID, -1))} />
          <Action label="▶" onClick={() => act(() => BrowserRuntime.history(props.sessionID, 1))} />
          <Action label="⟳" onClick={() => act(() => BrowserRuntime.reload(props.sessionID))} />
          <input
            flexGrow={1}
            minWidth={0}
            placeholder={t("Search or type a web address")}
            placeholderColor={theme.text.muted}
            focusedBackgroundColor={theme.background.formfield.focused}
            cursorColor={theme.text.formfield.focused}
            ref={(value: InputRenderable) => (address = value)}
            onSubmit={() => go(address?.value ?? "")}
          />
        </box>
        <Show when={failure()}>
          <text fg={theme.text.feedback.error.base} flexShrink={0}>
            {failure()}
          </text>
        </Show>
        <Show
          when={view() === "screen"}
          fallback={
            <scrollbox flexGrow={1} minHeight={0} horizontalScrollbarOptions={{ visible: false }}>
              <text fg={theme.text.base} wrapMode="word">
                {page().text}
              </text>
            </scrollbox>
          }
        >
          <box
            flexGrow={1}
            minHeight={0}
            minWidth={0}
            onSizeChange={function () {
              setSize({ cols: this.width, rows: this.height })
            }}
          >
            <browserImage ref={(value: ImageRenderable) => (picture = value)} flexGrow={1} fit="fill" />
          </box>
        </Show>
      </Show>
    </box>
  )
}
