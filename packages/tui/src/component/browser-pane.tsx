import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { HoverAction } from "./hover-action"
import {
  ImageRenderable,
  NativeImage,
  TextAttributes,
  type BoxRenderable,
  type KeyEvent,
  type MouseEvent,
} from "@opentui/core"
import { extend, useRenderer } from "@opentui/solid"
import { createEffect, createSignal, onCleanup, Show } from "solid-js"
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

// The commit this TUI runs from (when it runs from a git checkout), so a report can say which build it saw.
const BUILD = (() => {
  try {
    const out = spawnSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: fileURLToPath(new URL(".", import.meta.url)),
      encoding: "utf8",
      timeout: 2000,
      windowsHide: true,
    })
    return out.status === 0 ? out.stdout.trim() || "unknown" : "unknown"
  } catch {
    return "unknown"
  }
})()

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
  const [mode, setMode] = createSignal<"headless" | "window" | "capture">(BrowserRuntime.modeOf(props.sessionID))
  const windowed = () => mode() === "window"
  // The screen is the page streamed as pictures (kitty or sixel graphics when the terminal has them,
  // colored half-blocks otherwise); the text view stays as the plain fallback.
  const [view, setView] = createSignal<"screen" | "text">("screen")
  const renderer = useRenderer()
  const [size, setSize] = createSignal<{ cols: number; rows: number }>()
  let picture: ImageRenderable | undefined
  let screenBox: BoxRenderable | undefined
  // The page size Chrome is laid out at, so a click in the pane lands on the same spot of the page.
  let viewport = { width: 0, height: 0 }
  // What the last frame and the pane measured, shown under the page so a size mismatch is visible at once.
  const [stats, setStats] = createSignal("")
  let lastFrame = 0
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
    if (state() !== "ready" || view() !== "screen" || windowed() || !area) return
    const resolution = renderer.resolution
    const cellWidth = resolution ? resolution.width / renderer.width : 8
    const cellHeight = resolution ? resolution.height / renderer.height : 16
    const width = Math.min(MAX_WIDTH, Math.max(200, Math.round(area.cols * cellWidth)))
    const height = Math.min(MAX_HEIGHT, Math.max(120, Math.round(area.rows * cellHeight)))
    const timer = setTimeout(() => {
      viewport = { width, height }
      void BrowserRuntime.watch(props.sessionID, { width, height }, (frame) => {
        const now = Date.now()
        if (disposed || !picture || picture.isDestroyed || now - lastFrame < FRAME_GAP_MS) return
        lastFrame = now
        try {
          picture.source = NativeImage.decode(Buffer.from(frame.data, "base64"))
          const area = size()
          setStats(
            `frame ${frame.width}x${frame.height}px · asked ${viewport.width}x${viewport.height}px · pane ${area?.cols}x${area?.rows} cells`,
          )
        } catch {
          // A frame that does not decode is skipped; the next one replaces it.
        }
      }).catch((error) => !disposed && setFailure(errorMessage(error)))
    }, 200)
    onCleanup(() => clearTimeout(timer))
  })
  onCleanup(() => BrowserRuntime.unwatch(props.sessionID))

  // Control: the operator's mouse and keys go into the page instead of the app. Ctrl+G gives them back.
  const [control, setControl] = createSignal(false)
  const toPage = (event: { x: number; y: number }) => {
    if (!screenBox || screenBox.width <= 0 || screenBox.height <= 0) return undefined
    return {
      x: ((event.x - screenBox.x + 0.5) / screenBox.width) * viewport.width,
      y: ((event.y - screenBox.y + 0.5) / screenBox.height) * viewport.height,
    }
  }
  const send = (work: Promise<unknown>) => void work.catch((error) => !disposed && setFailure(errorMessage(error)))
  // While control is on, shows what the pane received and sent, so a lost event is visible.
  const [debug, setDebug] = createSignal("")
  const counts = { down: 0, up: 0, move: 0, key: 0 }
  const note = (kind: keyof typeof counts, text: string) => {
    counts[kind]++
    setDebug(`control: ${text} · got down ${counts.down} up ${counts.up} move ${counts.move} key ${counts.key}`)
  }
  // The pointer over the page while control is on: the terminal's pointer turns into a crosshair where it supports
  // that, and a marker is drawn at the spot as a fallback.
  const [marker, setMarker] = createSignal<{ x: number; y: number }>()
  createEffect(() => {
    if (!control()) return
    renderer.setMousePointer("crosshair")
    onCleanup(() => {
      renderer.setMousePointer("default")
      setMarker(undefined)
    })
  })
  const [route, setRoute] = createSignal("")
  const forward = (kind: "down" | "up" | "move", event: MouseEvent) => {
    if (!control()) return
    const at = toPage(event)
    if (!at) return note(kind, `${kind} ignored, pane has no size`)
    event.stopPropagation()
    if (screenBox) setMarker({ x: Math.max(0, event.x - screenBox.x), y: Math.max(0, event.y - screenBox.y) })
    note(kind, `${kind} page ${Math.round(at.x)},${Math.round(at.y)}`)
    send(
      BrowserRuntime.mouse(
        props.sessionID,
        kind === "move" ? { kind, ...at } : { kind, ...at, button: event.button === 2 ? "right" : "left" },
      ).then(
        (where) => setRoute(`${kind} -> ${where}`),
        (error) => {
          setRoute(`${kind} FAILED: ${errorMessage(error)}`)
          throw error
        },
      ),
    )
  }
  createEffect(() => {
    if (!control()) return
    const onKey = (key: KeyEvent) => {
      if (key.ctrl && key.name === "g") return (setControl(false), key.preventDefault(), key.stopPropagation())
      key.preventDefault()
      key.stopPropagation()
      if (key.eventType === "release") return
      note("key", `key ${key.name ?? key.sequence}`)
      send(BrowserRuntime.key(props.sessionID, key))
    }
    renderer.keyInput.on("keypress", onKey)
    onCleanup(() => void renderer.keyInput.off("keypress", onKey))
  })
  // Leaving the screen view, closing the browser, restarting Chrome or showing/hiding the chat always gives
  // the keyboard back.
  createEffect(() => {
    void props.chatHidden
    if (state() !== "ready" || view() !== "screen" || windowed()) setControl(false)
  })
  // Safety: a press anywhere outside the page (the composer, a dialog, a panel) ends control at once, so a
  // forgotten control mode can never leave the app without a keyboard. Presses inside the page stop at the
  // page box and never get here.
  createEffect(() => {
    if (!control()) return
    const root = renderer.root
    root.onMouse = (event: MouseEvent) => {
      if (event.type === "down") setControl(false)
    }
    onCleanup(() => void (root.onMouse = undefined))
  })

  // On Windows the real Chrome (its own tabs and address bar) is shown in the pane by default; if that cannot
  // start, the windowless stream stays and the reason is shown.
  const open = async () => {
    await run(async () => void (await BrowserRuntime.open(props.sessionID)))
    if (process.platform === "win32" && state() === "ready" && mode() === "headless") switchMode("capture")
  }

  // Chrome runs either windowless (streamed into this pane) or as a normal visible window with real Chrome tabs
  // and address bar. Switching restarts it on the same profile and reopens the tabs.
  const switchMode = (next: "headless" | "window" | "capture") => {
    setFailure(undefined)
    setState("busy")
    void BrowserRuntime.relaunch(props.sessionID, next, viewport.width > 0 ? viewport : undefined)
      .then(() => !disposed && setMode(BrowserRuntime.modeOf(props.sessionID)))
      .catch((error) => !disposed && setFailure(errorMessage(error)))
      // A failed capture falls back to the windowless Chrome, so read the mode that is really running.
      .finally(() => {
        if (disposed) return
        setMode(BrowserRuntime.modeOf(props.sessionID))
        setState("ready")
      })
  }
  const stop = () => {
    BrowserRuntime.close(props.sessionID)
    setPage({ url: "", title: "", text: "" })
    setMode("headless")
    setState("idle")
  }

  // Short labels when the pane is narrow, so the header stays on one line.
  const narrow = () => (size()?.cols ?? 0) < 130
  const Action = (action: { label: string; onClick: () => void }) => (
    <HoverAction paddingLeft={1} paddingRight={1} onClick={action.onClick}>
      <text fg={theme.text.action.primary.base} wrapMode="none">
        {action.label}
      </text>
    </HoverAction>
  )

  return (
    <box flexGrow={1} minWidth={0} minHeight={0} flexDirection="column" paddingLeft={1} paddingRight={1}>
      <Show
        when={state() !== "idle"}
        fallback={
          <box flexGrow={1} alignItems="center" justifyContent="center" flexDirection="column" gap={1}>
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
          <box flexGrow={1} />
          <Show when={props.canShowChat}>
            <Action label={props.chatHidden ? t("Show chat") : t("Hide chat")} onClick={props.onToggleChat} />
          </Show>
          <Show when={view() === "screen" && !windowed()}>
            <Action
              label={
                control()
                  ? narrow()
                    ? t("Release ^G")
                    : t("Release (Ctrl+G)")
                  : narrow()
                    ? t("Control")
                    : t("Take control")
              }
              onClick={() => setControl(!control())}
            />
          </Show>
          <Show when={!windowed()}>
            <Action
              label={view() === "screen" ? t("Text") : t("Screen")}
              onClick={() => {
                if (view() === "screen") BrowserRuntime.unwatch(props.sessionID)
                setView(view() === "screen" ? "text" : "screen")
              }}
            />
          </Show>
          <Show when={mode() === "headless" && process.platform === "win32"}>
            <Action
              label={narrow() ? t("Real Chrome") : t("Real Chrome in pane")}
              onClick={() => switchMode("capture")}
            />
          </Show>
          <Show when={mode() === "capture"}>
            <Action label={t("Fast view")} onClick={() => switchMode("headless")} />
          </Show>
          <Action label={narrow() ? t("Close") : t("Close browser")} onClick={stop} />
        </box>
        <Show when={control()}>
          <text fg={theme.text.feedback.success.base} flexShrink={0} wrapMode="word">
            {`${debug() || "control: on, waiting for mouse or keys"}${route() ? ` · ${route()}` : " · (no press forwarded yet)"} · build ${BUILD}`}
          </text>
        </Show>
        <Show when={failure()}>
          <text fg={theme.text.feedback.error.base} flexShrink={0}>
            {failure()}
          </text>
        </Show>
        <Show
          when={!windowed()}
          fallback={
            <box flexGrow={1} alignItems="center" justifyContent="center" flexDirection="column" gap={1}>
              <text fg={theme.text.base}>{t("Chrome is open in its own window.")}</text>
              <text fg={theme.text.muted}>
                {t("Its tabs, address bar and menus are Chrome's own. Same profile and logins.")}
              </text>
            </box>
          }
        >
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
              border
              borderStyle="rounded"
              borderColor={control() ? theme.text.feedback.success.base : theme.border.base}
            >
              <box
                flexGrow={1}
                minHeight={0}
                minWidth={0}
                ref={(value: BoxRenderable) => (screenBox = value)}
                onSizeChange={function () {
                  setSize({ cols: this.width, rows: this.height })
                }}
                onMouseDown={(event: MouseEvent) => forward("down", event)}
                onMouseUp={(event: MouseEvent) => forward("up", event)}
                onMouseMove={(event: MouseEvent) => forward("move", event)}
                onMouseDrag={(event: MouseEvent) => forward("move", event)}
                onMouseScroll={(event: MouseEvent) => {
                  const at = control() ? toPage(event) : undefined
                  if (!at || !event.scroll) return
                  event.stopPropagation()
                  send(
                    BrowserRuntime.mouse(props.sessionID, {
                      kind: "wheel",
                      ...at,
                      deltaX: event.scroll.direction === "left" ? -120 : event.scroll.direction === "right" ? 120 : 0,
                      deltaY: event.scroll.direction === "up" ? -120 : event.scroll.direction === "down" ? 120 : 0,
                    }),
                  )
                }}
              >
                <browserImage
                  ref={(value: ImageRenderable) => (picture = value)}
                  width={size()?.cols ?? 1}
                  height={size()?.rows ?? 1}
                  fit="fill"
                />
                <Show when={control() && marker()}>
                  <text
                    position="absolute"
                    left={marker()!.x}
                    top={marker()!.y}
                    fg={theme.text.feedback.success.base}
                    attributes={TextAttributes.BOLD}
                    selectable={false}
                  >
                    ✛
                  </text>
                </Show>
              </box>
            </box>
            <text fg={theme.text.muted} flexShrink={0} wrapMode="none" truncate>
              {`${stats()} · build ${BUILD}`}
            </text>
          </Show>
        </Show>
      </Show>
    </box>
  )
}
