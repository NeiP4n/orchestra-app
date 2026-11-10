import { EmbeddedTerminalRenderable } from "@opentui/core"
import { extend } from "@opentui/solid"
import { createSignal, onCleanup, onMount, Show } from "solid-js"
import { useClient } from "../context/client"
import { Keymap } from "../context/keymap"
import { useTheme, useThemes } from "../context/theme"
import { errorMessage } from "../util/error"
import { decodePtyFrame } from "../util/plain-pty-frame"

declare module "@opentui/solid" {
  interface OpenTUIComponents {
    embeddedTerminal: typeof EmbeddedTerminalRenderable
  }
}

extend({ embeddedTerminal: EmbeddedTerminalRenderable })

// A terminal for servers without the persistent PTY daemon (Windows): the plain PTY of a directory.
// The shell lives as long as the server and is found again by its title, so every session of one project
// directory reaches the same shell. There is no multi-client control handoff here.
const SCROLLBACK_LINES = 10_000

export const PLAIN_CONSOLE_TITLE = "Console"

export function PlainTerminalPane(props: { directory: string; autoFocus?: boolean; onPty?: (id: string | undefined) => void }) {
  const client = useClient()
  const keymap = Keymap.use()
  const leader = Keymap.useLeaderActive()
  const theme = useTheme()
  const themes = useThemes()
  const [failure, setFailure] = createSignal<string>()
  let terminal: EmbeddedTerminalRenderable | undefined
  let socket: WebSocket | undefined
  let disposed = false
  let ptyID: string | undefined
  let size = { cols: 80, rows: 24 }
  const location = { directory: props.directory }

  const offKeys = keymap.intercept(
    "key",
    ({ event }) => {
      if (!terminal?.focused) return
      if (keymap.isLeader(event) || leader()) return
      event.preventDefault()
      event.stopPropagation()
      terminal.handleKeyPress(event)
    },
    { priority: 100 },
  )

  const resize = (cols: number, rows: number) => {
    if (cols < 1 || rows < 1) return
    size = { cols, rows }
    if (terminal) {
      terminal.width = cols
      terminal.height = rows
    }
    if (ptyID) void client.api.pty.update({ ptyID, location, size }).catch(() => undefined)
  }

  // A one-column size change makes the shell (ConPTY) redraw its prompt and screen.
  const repaint = () => {
    if (!ptyID || size.cols < 2) return
    const id = ptyID
    void client.api.pty
      .update({ ptyID: id, location, size: { cols: size.cols - 1, rows: size.rows } })
      .then(() => new Promise((done) => setTimeout(done, 80)))
      .then(() => (disposed ? undefined : client.api.pty.update({ ptyID: id, location, size })))
      .catch(() => undefined)
  }

  onMount(() => {
    void connect().catch((error) => setFailure(errorMessage(error)))
  })
  onCleanup(() => {
    disposed = true
    props.onPty?.(undefined)
    socket?.close()
    offKeys()
  })

  async function connect() {
    const listed = await client.api.pty.list({ location })
    const existing = listed.data.find((item) => item.title === PLAIN_CONSOLE_TITLE && item.status === "running")
    const info =
      existing ?? (await client.api.pty.create({ location, cwd: props.directory, title: PLAIN_CONSOLE_TITLE })).data
    if (disposed) return
    ptyID = info.id
    props.onPty?.(info.id)
    resize(size.cols, size.rows)
    // Tail from the live end: replaying the whole retained buffer into a terminal of another size left the
    // screen blank with only the typed keys echoed at the bottom. The shell is then asked to repaint.
    const next = await client.pty.connect({ ptyID: info.id, location, cursor: existing ? -1 : 0 })
    if (disposed) {
      next.close()
      return
    }
    next.addEventListener("message", (event) => {
      if (disposed) return
      const chunk = decodePtyFrame(event.data)
      if (chunk) terminal?.write(chunk)
    })
    next.addEventListener("error", () => !disposed && setFailure("Terminal connection failed"))
    next.addEventListener("close", () => !disposed && setFailure("Terminal disconnected"))
    socket = next
    if (props.autoFocus) terminal?.focus()
    if (existing) repaint()
  }

  return (
    <box
      flexGrow={1}
      minWidth={0}
      minHeight={0}
      overflow="hidden"
      backgroundColor={themes.currentTokens().background.raised.base}
      onSizeChange={function () {
        resize(Math.max(1, this.width - 2), Math.max(1, this.height))
      }}
      onMouseDown={() => terminal?.focus()}
    >
      <Show when={!failure()} fallback={<text fg={theme.text.feedback.error.base}>{failure()}</text>}>
        <embeddedTerminal
          ref={(value) => {
            terminal = value
            value.width = size.cols
            value.height = size.rows
            if (props.autoFocus) value.focus()
          }}
          // The wheel scrolls this history when the program does not ask for mouse input.
          maxScrollback={SCROLLBACK_LINES}
          position="absolute"
          left={1}
          top={0}
          width={80}
          height={24}
          onData={(data, source) => {
            if (source === "input" && socket?.readyState === WebSocket.OPEN) socket.send(data)
          }}
        />
      </Show>
    </box>
  )
}
