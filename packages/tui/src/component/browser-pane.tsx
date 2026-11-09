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
import { createEffect, createSignal, For, onCleanup, Show } from "solid-js"
import { useTheme } from "../context/theme"
import { errorMessage } from "../util/error"
import { useT } from "../util/i18n"
import { useDialog } from "../ui/dialog"
import { DialogPrompt } from "../ui/dialog-prompt"
import * as BrowserRuntime from "../util/browser-runtime"
import { scheduleLine } from "../util/browser-schedule"
import { NeuronDot } from "./neural"

declare module "@opentui/solid" {
  interface OpenTUIComponents {
    browserImage: typeof ImageRenderable
  }
}

extend({ browserImage: ImageRenderable })

// The commit this TUI runs from (when it runs from a git checkout), so a report can say which build it saw.
// The route and frame-size lines are a diagnostic: shown only with ORCHESTRA_BROWSER_DEBUG=1.
const PIXEL_MOUSE = process.env.ORCHESTRA_BROWSER_PIXEL_MOUSE !== "0"
// A terminal pointer moves in cells (about 10x20 px), too coarse for the tab close button (about 16 px, centred in the
// tab strip). In a captured window a press in Chrome's tab strip is therefore moved to the strip's centre line, so
// the column the marker is on decides the hit. ORCHESTRA_BROWSER_STRIP_SNAP=0 turns it off.
const STRIP_SNAP = process.env.ORCHESTRA_BROWSER_STRIP_SNAP !== "0"
// ORCHESTRA_BROWSER_HALFBLOCKS=1 draws the page as block characters, never kitty/sixel graphics.
// ORCHESTRA_BROWSER_GFX=sixel|kitty|blocks|auto picks how the page is drawn. auto lets the renderer detect the
// terminal's graphics (kitty, then sixel) and fall back to quadrant blocks. Windows Terminal printed sixel data as
// text over the screen, so on Windows auto means blocks until sixel is asked for by name.
// ORCHESTRA_BROWSER_HALFBLOCKS=1 (blocks) and =0 (auto) still work.
const GFX = (() => {
  const named = (process.env.ORCHESTRA_BROWSER_GFX ?? "").trim().toLowerCase()
  if (named === "sixel" || named === "kitty" || named === "blocks") return named
  if (named === "auto") return "auto" as const
  if (process.env.ORCHESTRA_BROWSER_HALFBLOCKS === "1") return "blocks" as const
  if (process.env.ORCHESTRA_BROWSER_HALFBLOCKS === "0") return "auto" as const
  return process.platform === "win32" ? ("blocks" as const) : ("auto" as const)
})()
const IMAGE_PROTOCOL = GFX
const STRIP_SCALE = Math.min(3, Math.max(1, Number(process.env.ORCHESTRA_BROWSER_SCALE) || 1))
const DEBUG = process.env.ORCHESTRA_BROWSER_DEBUG === "1"
// The pane's own tab strip and address row, drawn whenever the picture is the page only (the windowless Chrome, also the
// fallback of a capture that went wrong), so the top bar is always there. A captured window has Chrome's own bar.
// ORCHESTRA_BROWSER_STRIP=0 hides it.
const STRIP = process.env.ORCHESTRA_BROWSER_STRIP !== "0"
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
// Blocks are cheap; sixel and kitty frames are large, so they are sent less often (a flood is what breaks a terminal).
const FRAME_GAP_MS = GFX === "blocks" ? 120 : 300

// The text view of one browser session: its page address, title and the page's visible text. It reads
// the page; pixels and clicking come later. Chrome starts only when the operator opens the page.
// Sessions whose agent-started Chrome is being taken over right now: two panes of one session must not both do it.
const takingOver = new Set<string>()
// Per TUI process, not per pane: a session's restart in progress, the sessions whose capture did not work (never tried
// again until the TUI restarts), and the one automatic switch allowed at a time (Browser 1, 2, 3 picked one after another).
const switching = new Set<string>()
const captureGaveUp = new Set<string>()
// Why a session's capture was given up in this TUI process (shown in the pane header, so nobody has to guess).
const captureWhy = new Map<string, string>()
const silentRetried = new Set<string>()
let autoSwitching = false
// No picture this long after a switch: capture goes back to the windowless Chrome; a windowless one says why it is silent.
const FIRST_FRAME_MS = 6000

export function BrowserPane(props: {
  sessionID: string
  name: string
  chatHidden: boolean
  canShowChat: boolean
  onToggleChat: () => void
  /** True while this session's BrowserAgent chat is working: Chrome is not restarted under it. */
  busy?: () => boolean
}) {
  const theme = useTheme()
  const t = useT()
  const [state, setState] = createSignal<"idle" | "busy" | "ready">(
    BrowserRuntime.isOpen(props.sessionID) ? "ready" : "idle",
  )
  const [page, setPage] = createSignal({ url: "", title: "", text: "" })
  const [scheduledChecks, setScheduledChecks] = createSignal(BrowserRuntime.scheduleStatus(props.sessionID))
  const [scheduleNow, setScheduleNow] = createSignal(Date.now())
  createEffect(() => {
    const sessionID = props.sessionID
    const refresh = () => {
      setScheduledChecks(BrowserRuntime.scheduleStatus(sessionID))
      setScheduleNow(Date.now())
    }
    refresh()
    // Only local status files are read. This does not check or refresh the site.
    const timer = setInterval(refresh, 2000)
    onCleanup(() => clearInterval(timer))
  })
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
  // Until the first picture is drawn the screen would be a black box: a line says what is going on and what to do.
  const [framed, setFramed] = createSignal(false)
  let disposed = false
  // Repaints every cell from scratch: whatever a picture or a mode switch left on the screen is overwritten.
  const repaint = () => {
    try {
      renderer.currentRenderBuffer.clear()
      renderer.requestRender()
    } catch {}
  }
  onCleanup(() => {
    disposed = true
    repaint()
  })

  // The page's own tab strip and address, drawn here because the streamed picture holds only the page. The list is
  // Chrome's (one profile, the same tabs the agent works in), read every 1.5 s while the pane is open.
  const dialog = useDialog()
  const [tabList, setTabList] = createSignal<ReadonlyArray<{ id: string; title: string; url: string; active: boolean }>>([])
  let reading = false
  const refreshTabs = async () => {
    if (reading || disposed) return
    reading = true
    try {
      const next = await BrowserRuntime.tabs(props.sessionID)
      if (!disposed) setTabList(next)
    } catch {
      // Chrome is starting or gone: the strip keeps the last list.
    } finally {
      reading = false
    }
  }
  createEffect(() => {
    if (!STRIP || state() !== "ready" || mode() === "capture") return
    void refreshTabs()
    // An empty list (Chrome still starting, or a read that failed) is read again soon, not after the full period.
    const timer = setInterval(() => void refreshTabs(), 1500)
    const quick = setInterval(() => {
      if (tabList().length === 0) void refreshTabs()
    }, 400)
    onCleanup(() => clearInterval(quick))
    onCleanup(() => clearInterval(timer))
  })
  // The runtime can leave capture by itself (the window printed blank, or could not be kept invisible): follow the real mode.
  createEffect(() => {
    if (state() !== "ready") return
    const timer = setInterval(() => {
      const real = BrowserRuntime.modeOf(props.sessionID)
      if (!disposed) setTick((value) => value + 1)
      if (!disposed && real !== mode()) {
        setMode(real)
        repaint()
      }
    }, 1000)
    onCleanup(() => clearInterval(timer))
  })
  const tabAction = (work: () => Promise<unknown>) =>
    void work()
      .then(refreshTabs)
      .catch((error) => setFailure(errorMessage(error)))
  const tabLabel = (tab: { title: string; url: string }) => {
    let host = ""
    try {
      host = new URL(tab.url).host.replace(/^www\./, "")
    } catch {}
    const text = (tab.title || host || t("New tab")).trim()
    return text.length > 18 ? `${text.slice(0, 17)}…` : text
  }
  const currentUrl = () => tabList().find((tab) => tab.active)?.url ?? page().url
  const editAddress = () =>
    dialog.replace(() => (
      <DialogPrompt
        title={t("Address")}
        placeholder={t("https://... or search words")}
        value={currentUrl()}
        onCancel={() => dialog.clear()}
        onConfirm={(value) => {
          dialog.clear()
          const address = value.trim()
          if (address) tabAction(() => BrowserRuntime.go(props.sessionID, address))
        }}
      />
    ))

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
          setFramed(true)
          // A captured window may be a little off the size asked for: the clicks map onto what is really shown.
          if (mode() === "capture" && frame.width > 0 && frame.height > 0)
            viewport = { width: frame.width, height: frame.height }
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
    // A release after dragging out of the pane still arrives; it lands on the nearest edge instead of outside the page.
    const inside = (value: number, size: number) => Math.min(size - 1, Math.max(0, value))
    return {
      x: inside(((event.x - screenBox.x + 0.5) / screenBox.width) * viewport.width, viewport.width),
      y: inside(((event.y - screenBox.y + 0.5) / screenBox.height) * viewport.height, viewport.height),
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
  // Where an agent's browser tool last clicked or typed in this session: a marker in the agent's own colour that
  // stays a few seconds and is gone. ORCHESTRA_AGENT_CURSOR=0 (read by the tool) writes nothing, so nothing shows.
  const [agentAt, setAgentAt] = createSignal<{ x: number; y: number }>()
  createEffect(() => {
    const timer = setInterval(() => {
      const spot = BrowserRuntime.agentCursor(props.sessionID)
      const area = size()
      const next =
        !spot || !area || Date.now() - spot.at > 4000
          ? undefined
          : { x: Math.min(Math.max(0, area.cols - 8), Math.floor(spot.x * area.cols)), y: Math.min(area.rows - 1, Math.floor(spot.y * area.rows)) }
      const before = agentAt()
      if (before?.x !== next?.x || before?.y !== next?.y || (before === undefined) !== (next === undefined)) setAgentAt(next)
    }, 250)
    onCleanup(() => clearInterval(timer))
  })
  const [route, setRoute] = createSignal("")
  // While the operator has control, the agent's browser tool is refused for this session; letting go frees it
  // again (an assignment to an agent is never cleared by this).
  createEffect(() => {
    if (!control()) return
    const before = BrowserRuntime.leases()[props.sessionID]
    try {
      BrowserRuntime.setLease(props.sessionID, "operator")
    } catch {
      // Without the file the agent is simply not held back.
    }
    onCleanup(() => {
      try {
        BrowserRuntime.setLease(props.sessionID, before && before.agent !== "operator" ? before.agent : undefined)
      } catch {
        // See above.
      }
    })
  })
  let pixelsSeen = false
  let moving = false
  let latestMove: { x: number; y: number } | undefined
  const forward = (kind: "down" | "up" | "move", event: MouseEvent) => {
    if (!control()) return
    // With pixel reports on, the exact position arrives separately; the cell event only repeats it roughly.
    if (pixelsSeen) return void event.stopPropagation()
    const at = toPage(event)
    if (!at) return note(kind, `${kind} ignored, pane has no size`)
    event.stopPropagation()
    if (screenBox) setMarker({ x: Math.max(0, event.x - screenBox.x), y: Math.max(0, event.y - screenBox.y) })
    deliver(kind, at, event.button === 2 ? "right" : "left")
  }
  const deliver = (kind: "down" | "up" | "move", point: { x: number; y: number }, button: "left" | "right") => {
    const snapped = STRIP_SNAP && mode() === "capture" && point.y < 40 * STRIP_SCALE
    const at = snapped ? { x: point.x, y: 20 * STRIP_SCALE } : point
    note(kind, `${kind} page ${Math.round(at.x)},${Math.round(at.y)}${snapped ? " (tab strip centre line)" : ""}`)
    const step = (text: string) => setRoute(`${kind}: ${text}`)
    // Moves are coalesced: while one is on its way only the newest position waits, so the pointer never lags
    // behind a queue of stale positions. Presses and releases always go, in order, after the pending move.
    if (kind === "move") {
      if (moving) return void (latestMove = at)
      moving = true
    }
    step("pane sent")
    const run = (point: { x: number; y: number }) =>
      BrowserRuntime.mouse(props.sessionID, kind === "move" ? { kind, ...point } : { kind, ...point, button }, step)
    send(
      run(at)
        .then(
          (where) => setRoute(`${kind} -> ${where}`),
          (error) => {
            setRoute(`${kind} FAILED: ${errorMessage(error)}`)
            throw error
          },
        )
        .finally(() => {
          if (kind !== "move") return
          moving = false
          const next = latestMove
          latestMove = undefined
          if (next && control()) send(BrowserRuntime.mouse(props.sessionID, { kind: "move", ...next }))
        }),
    )
  }
  // On by default while control is on (ORCHESTRA_BROWSER_PIXEL_MOUSE=0 turns it off): terminals report the pointer in cells, about 10x20 pixels each,
  // too coarse for a tab's close button. Where the terminal can report pixels (DECSET 1016), the exact position
  // is read from the raw input while control is on. Everything seen is logged.
  createEffect(() => {
    if (!control() || !PIXEL_MOUSE) return
    const resolution = renderer.resolution
    BrowserRuntime.trace(
      `pixel mouse on: terminal ${renderer.width}x${renderer.height} cells, resolution ${resolution ? `${resolution.width}x${resolution.height}` : "unknown"}, box ${screenBox ? `${screenBox.x},${screenBox.y} ${screenBox.width}x${screenBox.height}` : "none"}`,
    )
    process.stdout.write("\x1b[?1016h")
    let logged = 0
    const onData = (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("latin1")
      for (const match of text.matchAll(/\x1b\[<(\d+);(\d+);(\d+)([Mm])/g)) {
        const code = Number(match[1])
        const px = Number(match[2])
        const py = Number(match[3])
        if (logged < 12) {
          logged++
          BrowserRuntime.trace(`raw mouse ${JSON.stringify(match[0])}`)
        }
        // Cell reports never exceed the terminal size; larger numbers can only be pixels.
        if (px > renderer.width || py > renderer.height) pixelsSeen = true
        if (!pixelsSeen || !screenBox || !resolution) continue
        const cw = resolution.width / renderer.width
        const ch = resolution.height / renderer.height
        const left = screenBox.x * cw
        const top = screenBox.y * ch
        const at = {
          x: ((px - 1 - left) / (screenBox.width * cw)) * viewport.width,
          y: ((py - 1 - top) / (screenBox.height * ch)) * viewport.height,
        }
        if (at.x < 0 || at.y < 0 || at.x > viewport.width || at.y > viewport.height) continue
        setMarker({
          x: Math.max(0, Math.floor((px - 1) / cw) - screenBox.x),
          y: Math.max(0, Math.floor((py - 1) / ch) - screenBox.y),
        })
        const motion = (code & 32) === 32
        const button = (code & 3) === 2 ? "right" : "left"
        if ((code & 64) === 64) continue
        deliver(motion || (code & 3) === 3 ? "move" : match[4] === "M" ? "down" : "up", at, button)
      }
    }
    process.stdin.on("data", onData)
    onCleanup(() => {
      process.stdin.off("data", onData)
      process.stdout.write("\x1b[?1016l")
      pixelsSeen = false
    })
  })
  createEffect(() => {
    if (!control()) return
    const onPaste = (event: { bytes: Uint8Array }) => {
      const text = new TextDecoder().decode(event.bytes)
      if (!text) return
      note("key", `paste ${text.length} chars`)
      send(BrowserRuntime.key(props.sessionID, { name: "paste", sequence: text }))
    }
    const onKey = (key: KeyEvent) => {
      BrowserRuntime.trace(
        `pane got key name=${key.name} sequence=${JSON.stringify(key.sequence)} ctrl=${key.ctrl} meta=${key.meta} shift=${key.shift} type=${key.eventType}`,
      )
      note("key", `key ${key.name ?? key.sequence} ${key.eventType}`)
      if (key.ctrl && key.name === "g") return (setControl(false), key.preventDefault(), key.stopPropagation())
      key.preventDefault()
      key.stopPropagation()
      if (key.eventType === "release") return
      const input = { name: key.name, sequence: key.sequence, ctrl: key.ctrl, meta: key.meta }
      send(
        BrowserRuntime.key(props.sessionID, input).then(
          (where) => setRoute(`key ${input.name ?? input.sequence} -> ${where}`),
          (error) => {
            setRoute(`key ${input.name ?? input.sequence} FAILED: ${errorMessage(error)}`)
            throw error
          },
        ),
      )
    }
    // First in line: the app's own key handlers (Enter and Backspace belong to the composer and its commands)
    // run in registration order and any of them may stop the key before a later listener sees it.
    renderer.keyInput.prependListener("keypress", onKey)
    renderer.keyInput.prependListener("paste", onPaste)
    onCleanup(() => {
      renderer.keyInput.off("keypress", onKey)
      renderer.keyInput.off("paste", onPaste)
    })
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

  // The page is Chrome's own window captured into the pane (its real tabs and address bar) on Windows, when the helper
  // proved the window invisible and its pictures are not blank; otherwise, and everywhere else, the windowless Chrome
  // streamed here with this pane's own tab strip. A capture that goes wrong later falls back to the windowless Chrome
  // by itself. Capture is opt-in: ORCHESTRA_BROWSER_CAPTURE=1 enables auto capture; default keeps the windowless view. The explicit "Real Chrome" button stays.
  const autoCapture = process.platform === "win32" && process.env.ORCHESTRA_BROWSER_CAPTURE === "1"
  const open = async () => {
    await run(async () => void (await BrowserRuntime.open(props.sessionID)))
    setMode(BrowserRuntime.modeOf(props.sessionID))
  }
  // Every session's Chrome ends up in capture, however it started (this pane, or the agent's windowless one): once the
  // pane shows it, and only between the agent's turns, it is restarted once as the captured real window. Tried once
  // per pane: a capture that failed (or "Fast view" pressed) is not tried again until the pane is reopened.
  createEffect(() => {
    if (!autoCapture || state() !== "ready") return
    const timer = setInterval(() => {
      if (disposed || state() !== "ready" || mode() !== "headless") return
      // Only once the windowless picture is on screen (the user sees the page first), never twice for a session,
      // never while another switch runs, never under a working agent.
      if (!framed() || captureGaveUp.has(props.sessionID) || switching.has(props.sessionID) || autoSwitching) return
      if (props.busy?.()) return
      autoSwitching = true
      switchMode("capture", true)
    }, 1500)
    onCleanup(() => clearInterval(timer))
  })

  // The agent's browser tool starts the session's Chrome in the server process, windowless. While this pane
  // still shows the Open Chrome screen, a Chrome running on the session's profile is taken over and shown here,
  // as if Open Chrome had been pressed. A failed start stops this until the operator presses the button.
  createEffect(() => {
    let busy = false
    const timer = setInterval(() => {
      if (busy || disposed || state() !== "idle" || failure() || takingOver.has(props.sessionID)) return
      busy = true
      takingOver.add(props.sessionID)
      void BrowserRuntime.peek(props.sessionID)
        .then((found) => {
          if (found.running && !disposed && state() === "idle" && !failure()) {
            BrowserRuntime.trace(`pane ${props.sessionID}: Chrome of the agent found (${found.url ?? "no page"}), taking it over`)
            return open()
          }
        })
        .catch((error) => BrowserRuntime.trace(`pane ${props.sessionID}: takeover failed: ${errorMessage(error)}`))
        .finally(() => {
          busy = false
          takingOver.delete(props.sessionID)
        })
    }, 1500)
    onCleanup(() => clearInterval(timer))
  })

  // Chrome runs either windowless (streamed into this pane) or as a normal visible window with real Chrome tabs
  // and address bar. Switching restarts it on the same profile and reopens the tabs.
  const [modeNote, setModeNote] = createSignal<string>()
  // One line that says whether Chrome's own window is shown and, when it is not, why. The runtime's own fall-back reason
  // (blank print, window could not be hidden) is read with the 1 s mode poll's tick.
  const [tick, setTick] = createSignal(0)
  const captureLine = () => {
    tick()
    if (process.platform !== "win32" || mode() === "window") return undefined
    const attempt = BrowserRuntime.captureAttemptOf(props.sessionID)
    if (mode() === "capture") return `capture: on (Chrome's own window, attempt: ${attempt})`
    const reason = captureWhy.get(props.sessionID) ?? BrowserRuntime.captureProblemOf(props.sessionID)
    // The runtime is trying the next way (gpu -> software -> no-layered) after a blank print: not a final fall-back yet.
    if (BrowserRuntime.captureRetrying(props.sessionID))
      return `capture: retrying, attempt: ${attempt}${reason ? ` (after: ${reason})` : ""}`
    if (!autoCapture) return "capture: off (safe default), fast view"
    if (reason) return `capture: off, fast view because: ${reason} (last attempt: ${attempt})`
    if (switching.has(props.sessionID)) return "capture: starting"
    if (!framed()) return "capture: waits for the first picture"
    if (props.busy?.()) return "capture: waits until the agent's turn ends"
    return "capture: starts in a moment"
  }
  // The line is also written to the browser debug log whenever it changes, so the capture state can be read without the TUI
  // (the log is %LOCALAPPDATA%-style data folder browser-debug.log, and orchestra-browser-debug.log in the home folder).
  let lastCaptureLine: string | undefined
  createEffect(() => {
    const line = captureLine()
    if (line === undefined || line === lastCaptureLine) return
    lastCaptureLine = line
    BrowserRuntime.trace(`capture line ${props.sessionID}: ${line}`)
  })
  const switchMode = (next: "headless" | "window" | "capture", auto = false) => {
    if (switching.has(props.sessionID)) {
      if (auto) autoSwitching = false
      return
    }
    switching.add(props.sessionID)
    if (next === "capture") captureWhy.delete(props.sessionID)
    setFailure(undefined)
    setModeNote(next === "capture" ? t("Switching to Chrome's own window (up to 15 seconds)...") : undefined)
    setFramed(false)
    setState("busy")
    BrowserRuntime.trace(`pane ${props.sessionID}: switching to ${next}${auto ? " (automatic)" : ""}`)
    void BrowserRuntime.relaunch(props.sessionID, next, viewport.width > 0 ? viewport : undefined)
      .then(() => !disposed && setMode(BrowserRuntime.modeOf(props.sessionID)))
      .catch((error) => {
        BrowserRuntime.trace(`pane ${props.sessionID}: switch to ${next} failed: ${errorMessage(error)}`)
        if (next === "capture") {
          captureGaveUp.add(props.sessionID)
          captureWhy.set(props.sessionID, errorMessage(error))
        }
        if (!disposed) setFailure(errorMessage(error))
      })
      // A failed capture falls back to the windowless Chrome, so read the mode that is really running.
      .finally(() => {
        switching.delete(props.sessionID)
        if (auto) autoSwitching = false
        if (disposed) return
        const real = BrowserRuntime.modeOf(props.sessionID)
        setMode(real)
        setState("ready")
        repaint()
        if (next === "capture" && real !== "capture") {
          captureGaveUp.add(props.sessionID)
          captureWhy.set(props.sessionID, BrowserRuntime.captureProblemOf(props.sessionID) ?? "Chrome's window did not start")
          setModeNote(t("Chrome's own window did not start here: showing the fast view."))
          return
        }
        setModeNote(undefined)
        if (real === "capture") watchFirstFrame()
      })
  }
  // A captured window that sends no picture within the time limit is dropped for the windowless Chrome, with the reason logged.
  const watchFirstFrame = () => {
    setTimeout(() => {
      if (disposed || framed() || mode() !== "capture" || switching.has(props.sessionID)) return
      BrowserRuntime.trace(`pane ${props.sessionID}: no picture ${FIRST_FRAME_MS} ms after capture started, back to the windowless Chrome`)
      captureGaveUp.add(props.sessionID)
      captureWhy.set(props.sessionID, `no picture ${FIRST_FRAME_MS / 1000} s after the window started`)
      switchMode("headless")
      setModeNote(t("Chrome's own window sent no picture: showing the fast view."))
    }, FIRST_FRAME_MS)
  }
  // The windowless Chrome silent for this long: say so instead of waiting for ever (and log it).
  const [waitedLong, setWaitedLong] = createSignal(false)
  const [silentReason, setSilentReason] = createSignal("")
  createEffect(() => {
    if (state() !== "ready" || framed() || mode() !== "headless") return setWaitedLong(false)
    const timer = setTimeout(() => {
      if (disposed || framed()) return
      void BrowserRuntime.peek(props.sessionID)
        .then((found) => {
          if (disposed || framed()) return
          const reason = found.running
            ? `Chrome is running (${found.url || "no page"}) but sends no picture.`
            : "Chrome is not running in this session."
          BrowserRuntime.trace(`pane ${props.sessionID}: no picture 10 s after the windowless Chrome started: ${reason}`)
          setSilentReason(reason)
          setWaitedLong(true)
          // One quiet retry per session: the picture stream is started again (a stream that never began or died).
          if (found.running && !silentRetried.has(props.sessionID)) {
            silentRetried.add(props.sessionID)
            setState("busy")
            setTimeout(() => !disposed && setState("ready"), 100)
          }
        })
        .catch(() => undefined)
    }, 10_000)
    onCleanup(() => clearTimeout(timer))
  })

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
      <Show when={scheduledChecks().length > 0} fallback={
        <text fg={theme.text.muted} wrapMode="none">Read-only page checks: off</text>
      }>
        <For each={scheduledChecks()}>{(check) => (
          <box flexDirection="row" flexShrink={0} gap={1}>
            <Show when={check.enabled && check.phase === "checking"}>
              <NeuronDot energy={0.9} />
            </Show>
            <text fg={check.phase === "error" ? theme.text.feedback.error.base : theme.text.muted} wrapMode="word">
              {scheduleLine(check, scheduleNow())}
            </text>
          </box>
        )}</For>
      </Show>
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
          {/* The BrowserAgent of this session is working right now: the same firing neuron as in the session list. */}
          <Show when={props.busy?.()}>
            <NeuronDot energy={0.9} />
            <text fg={theme.text.muted}>{narrow() ? "" : ` ${t("running")}`}</text>
          </Show>
          <Show when={captureLine()}>
            <text fg={theme.text.muted} wrapMode="none" truncate>{`${props.busy?.() ? "  " : ""}${captureLine()}`}</text>
          </Show>
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
            <Action label={t("Fast view")} onClick={() => {
              captureGaveUp.add(props.sessionID)
              captureWhy.set(props.sessionID, "you pressed Fast view")
              switchMode("headless")
            }} />
          </Show>
          <Action label={narrow() ? t("Close") : t("Close browser")} onClick={stop} />
        </box>
        <Show when={STRIP && !windowed() && mode() !== "capture"}>
          <box flexDirection="row" flexShrink={0} gap={0} height={1}>
            <HoverAction paddingLeft={1} paddingRight={1} onClick={() => tabAction(() => BrowserRuntime.history(props.sessionID, -1))}>
              <text fg={theme.text.action.primary.base}>{"‹"}</text>
            </HoverAction>
            <HoverAction paddingLeft={1} paddingRight={1} onClick={() => tabAction(() => BrowserRuntime.history(props.sessionID, 1))}>
              <text fg={theme.text.action.primary.base}>{"›"}</text>
            </HoverAction>
            <HoverAction paddingLeft={1} paddingRight={1} onClick={() => tabAction(() => BrowserRuntime.reload(props.sessionID))}>
              <text fg={theme.text.action.primary.base}>{"⟳"}</text>
            </HoverAction>
            <box flexGrow={1} minWidth={0} paddingLeft={1} onMouseDown={editAddress}>
              <text fg={theme.text.base} wrapMode="none" truncate>
                {currentUrl() || t("about:blank")}
              </text>
            </box>
          </box>
          <box flexDirection="row" flexShrink={0} gap={0} height={1} overflow="hidden">
            <For each={tabList()}>
              {(tab) => (
                <>
                  <HoverAction paddingLeft={1} onClick={() => tabAction(() => BrowserRuntime.selectTab(props.sessionID, tab.id))}>
                    <text
                      fg={tab.active ? theme.text.base : theme.text.muted}
                      attributes={tab.active ? TextAttributes.BOLD | TextAttributes.UNDERLINE : undefined}
                      wrapMode="none"
                    >
                      {tabLabel(tab)}
                    </text>
                  </HoverAction>
                  <HoverAction paddingRight={1} onClick={() => tabAction(() => BrowserRuntime.closeTab(props.sessionID, tab.id))}>
                    <text fg={theme.text.muted}>{" ×"}</text>
                  </HoverAction>
                </>
              )}
            </For>
            <HoverAction paddingLeft={1} paddingRight={1} onClick={() => tabAction(() => BrowserRuntime.newTab(props.sessionID))}>
              <text fg={theme.text.action.primary.base}>{"+"}</text>
            </HoverAction>
          </box>
        </Show>
        <Show when={DEBUG && control()}>
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
                  protocol={IMAGE_PROTOCOL}
                />
                <Show when={!framed()}>
                  <box position="absolute" left={0} top={0} width="100%" height="100%" alignItems="center" justifyContent="center" flexDirection="column">
                    <text fg={theme.text.muted}>{modeNote() ?? t("Waiting for the page picture...")}</text>
                    <Show when={waitedLong()}>
                      <text fg={theme.text.feedback.warning.base}>
                        {`${silentReason()} ${t("Press Text, or Close browser and Open Chrome; a terminal without pictures needs ORCHESTRA_BROWSER_GFX=blocks.")}`}
                      </text>
                    </Show>
                  </box>
                </Show>
                <Show when={!control() && agentAt()}>
                  <text
                    position="absolute"
                    left={agentAt()!.x}
                    top={agentAt()!.y}
                    fg={theme.text.feedback.warning.base}
                    attributes={TextAttributes.BOLD}
                    selectable={false}
                  >
                    ◆ agent
                  </text>
                </Show>
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
            <Show when={DEBUG}>
              <text fg={theme.text.muted} flexShrink={0} wrapMode="none" truncate>
                {`${stats()} · build ${BUILD}`}
              </text>
            </Show>
          </Show>
        </Show>
      </Show>
    </box>
  )
}
