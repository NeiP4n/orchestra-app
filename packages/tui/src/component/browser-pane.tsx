import { TextAttributes, type InputRenderable } from "@opentui/core"
import { createSignal, onCleanup, Show } from "solid-js"
import { useTheme } from "../context/theme"
import { errorMessage } from "../util/error"
import { useT } from "../util/i18n"
import * as BrowserRuntime from "../util/browser-runtime"

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
  let address: InputRenderable | undefined
  let disposed = false
  onCleanup(() => (disposed = true))

  const run = async (work: () => Promise<void>) => {
    setFailure(undefined)
    setState("busy")
    try {
      await work()
      if (disposed) return
      setPage(await BrowserRuntime.read(props.sessionID))
    } catch (error) {
      if (!disposed) setFailure(errorMessage(error))
    } finally {
      if (!disposed) setState("ready")
    }
  }

  const open = () => run(async () => void (await BrowserRuntime.open(props.sessionID)))
  const go = (value: string) =>
    run(async () => {
      await BrowserRuntime.go(props.sessionID, value)
      // The page needs a moment to load before its text is read.
      await new Promise((done) => setTimeout(done, 1500))
    })
  const reload = () => run(async () => {})
  const stop = () => {
    BrowserRuntime.close(props.sessionID)
    setPage({ url: "", title: "", text: "" })
    setState("idle")
  }

  const Action = (action: { label: string; onClick: () => void }) => (
    <box paddingLeft={1} paddingRight={1} onMouseUp={action.onClick}>
      <text fg={theme.text.action.primary.base}>{action.label}</text>
    </box>
  )

  return (
    <box flexGrow={1} minWidth={0} minHeight={0} flexDirection="column" paddingLeft={1} paddingRight={1}>
      <box flexDirection="row" flexShrink={0} gap={1}>
        <text fg={theme.text.base} attributes={TextAttributes.BOLD}>{`${t("Browser")} · ${props.name}`}</text>
        <box flexGrow={1} />
        <Show when={props.canShowChat}>
          <Action label={props.chatHidden ? t("Show chat") : t("Hide chat")} onClick={props.onToggleChat} />
        </Show>
        <Show when={state() !== "idle"}>
          <Action label={t("Reload")} onClick={() => void reload()} />
          <Action label={t("Close browser")} onClick={stop} />
        </Show>
      </box>
      <Show
        when={state() !== "idle"}
        fallback={
          <box flexGrow={1} alignItems="center" justifyContent="center" flexDirection="column" gap={1}>
            <text fg={theme.text.muted}>{t("This session runs its own Google Chrome with a separate profile.")}</text>
            <Action label={`▶ ${t("Open Chrome")}`} onClick={() => void open()} />
            <Show when={failure()}>
              <text fg={theme.text.feedback.error.base}>{failure()}</text>
            </Show>
          </box>
        }
      >
        <box flexDirection="row" flexShrink={0} gap={1}>
          <text fg={theme.text.muted} flexShrink={0}>
            {"⌖"}
          </text>
          <input
            flexGrow={1}
            minWidth={0}
            placeholder={t("Web address, then Enter")}
            placeholderColor={theme.text.muted}
            focusedBackgroundColor={theme.background.formfield.focused}
            cursorColor={theme.text.formfield.focused}
            ref={(value: InputRenderable) => (address = value)}
            onSubmit={(value: string) => void go(value)}
          />
        </box>
        <text fg={theme.text.muted} wrapMode="none" truncate flexShrink={0}>
          {state() === "busy" ? t("Loading…") : `${page().title || t("(no title)")}  ${page().url}`}
        </text>
        <Show when={failure()}>
          <text fg={theme.text.feedback.error.base} flexShrink={0}>
            {failure()}
          </text>
        </Show>
        <scrollbox flexGrow={1} minHeight={0} horizontalScrollbarOptions={{ visible: false }}>
          <text fg={theme.text.base} wrapMode="word">
            {page().text}
          </text>
        </scrollbox>
      </Show>
    </box>
  )
}
