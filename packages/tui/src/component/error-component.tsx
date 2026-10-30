import { TextAttributes, type ScrollBoxRenderable } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { createSignal, For, Show } from "solid-js"
import { getScrollAcceleration } from "../util/scroll"
import { useClipboard } from "../context/clipboard"
import { useExit } from "../context/exit"
import { useTuiApp } from "../context/runtime"
import { useTheme } from "../context/theme"
import { getOrchestraTheme } from "../theme"
import { resolveThemeDocument } from "@orchestra/theme/tui"
import { createComponentTheme, type ComponentTheme } from "../theme/component"
import { describeOS, describeTerminal } from "../util/system"

export function ErrorComponent(props: { error: Error; reset: () => void; mode?: "dark" | "light" }) {
  const term = useTerminalDimensions()
  const exit = useExit()
  const clipboard = useClipboard()
  const app = useTuiApp()
  const [copyState, setCopyState] = createSignal<"idle" | "copied" | "failed">("idle")

  let theme: ComponentTheme
  try {
    theme = useTheme()
  } catch {
    const doc = getOrchestraTheme()
    const resolved = resolveThemeDocument(doc, props.mode ?? "dark")
    theme = createComponentTheme(() => resolved)
  }

  const message = props.error.message || "An unknown error occurred."
  const stack = props.error.stack || "No stack trace available."
  const issueURL = buildIssueURL(message, stack, app.version)

  const copyReport = () => {
    void clipboard
      .write(issueURL.toString())
      .then(() => setCopyState("copied"))
      .catch(() => setCopyState("failed"))
  }

  const actions = [
    {
      key: "c",
      label: () => ({ idle: "Copy report", copied: "Copied", failed: "Copy failed" })[copyState()],
      copy: true,
      onUse: copyReport,
    },
    { key: "r", label: () => "Restart", onUse: props.reset },
    { key: "q", label: () => "Quit", onUse: () => exit() },
  ]
  const [selected, setSelected] = createSignal(0)
  const move = (delta: number) => setSelected((prev) => (prev + delta + actions.length) % actions.length)
  let scroll: ScrollBoxRenderable | undefined

  useKeyboard((evt) => {
    if (evt.ctrl && evt.name === "c") return exit()
    if (evt.name === "return") {
      evt.preventDefault()
      evt.stopPropagation()
      return actions[selected()].onUse()
    }
    if (evt.name === "left") {
      evt.preventDefault()
      evt.stopPropagation()
      return move(-1)
    }
    if (evt.name === "right") {
      evt.preventDefault()
      evt.stopPropagation()
      return move(1)
    }
    if (evt.name === "tab") {
      evt.preventDefault()
      evt.stopPropagation()
      return move(evt.shift ? -1 : 1)
    }
    // Vertical keys scroll the stack trace; buttons navigate horizontally.
    if (evt.name === "up") return scroll?.scrollBy(-1)
    if (evt.name === "down") return scroll?.scrollBy(1)
    if (evt.name === "pageup" && scroll) return scroll.scrollBy(-scroll.height)
    if (evt.name === "pagedown" && scroll) return scroll.scrollBy(scroll.height)
    if (evt.name === "home" && scroll) return scroll.scrollTo(0)
    if (evt.name === "end" && scroll) return scroll.scrollTo(scroll.scrollHeight)
    if (evt.name === "q") return exit()
    if (evt.name === "c") return copyReport()
    if (evt.name === "r") return props.reset()
  })

  // Responsive thresholds.
  const contentWidth = () => Math.min(84, Math.max(24, term().width - 4))
  const showSubtext = () => term().height >= 18
  const showFooter = () => term().height >= 20

  return (
    <box
      width={term().width}
      height={term().height}
      backgroundColor={theme.background.base}
      flexDirection="column"
      alignItems="center"
    >
      <box width={contentWidth()} flexGrow={1} flexDirection="column" paddingTop={1} paddingBottom={1} gap={1}>
        {/* Headline */}
        <box flexDirection="column" alignItems="center" flexShrink={0}>
          <text attributes={TextAttributes.BOLD} fg={theme.text.base}>
            Orchestra crashed
          </text>
          <Show when={showSubtext()}>
            <text fg={theme.text.muted}>An unexpected error stopped the session.</text>
          </Show>
        </box>

        {/* Error message panel */}
        <box
          flexShrink={0}
          border
          borderStyle="rounded"
          borderColor={theme.text.feedback.error.base}
          title=" Error "
          titleColor={theme.text.feedback.error.base}
          paddingLeft={2}
          paddingRight={2}
        >
          <text fg={theme.text.base}>{message}</text>
        </box>

        {/* Actions */}
        <box flexDirection="row" flexWrap="wrap" justifyContent="center" gap={2} rowGap={1} flexShrink={0}>
          <For each={actions}>
            {(action, index) => {
              const isSelected = () => selected() === index()
              const copyColor = () =>
                action.copy
                  ? copyState() === "copied"
                    ? theme.text.feedback.success.base
                    : copyState() === "failed"
                      ? theme.text.feedback.error.base
                      : undefined
                  : undefined
              return (
                <box flexDirection="column" alignItems="center" flexShrink={0}>
                  <box
                    onMouseDown={() => setSelected(index())}
                    onMouseUp={() => action.onUse()}
                    backgroundColor={
                      copyColor() ?? (isSelected() ? theme.background.action.primary.focused : theme.background.raised.base)
                    }
                    minWidth={15}
                    alignItems="center"
                    paddingLeft={2}
                    paddingRight={2}
                  >
                    <text
                      attributes={TextAttributes.BOLD}
                      fg={copyColor() || isSelected() ? theme.text.action.primary.focused : theme.text.base}
                    >
                      {action.label()}
                    </text>
                  </box>
                  <text fg={isSelected() ? theme.background.action.primary.focused : theme.text.muted}>{action.key}</text>
                </box>
              )
            }}
          </For>
        </box>

        {/* Stack trace */}
        <box
          flexGrow={1}
          flexBasis={0}
          minHeight={3}
          border
          borderStyle="rounded"
          borderColor={theme.border.base}
          title=" Stack trace "
          titleColor={theme.text.muted}
          bottomTitle=" ↑↓ scroll "
          bottomTitleAlignment="right"
          paddingLeft={1}
          paddingRight={1}
        >
          <scrollbox
            ref={(element: ScrollBoxRenderable) => (scroll = element)}
            flexGrow={1}
            scrollAcceleration={getScrollAcceleration()}
          >
            <text fg={theme.text.muted}>{stack}</text>
          </scrollbox>
        </box>

        {/* Footer */}
        <Show when={showFooter()}>
          <box flexDirection="column" alignItems="center" flexShrink={0}>
            <text fg={theme.text.muted}>
              {copyState() === "copied"
                ? "Report copied — paste it into a new GitHub issue."
                : copyState() === "failed"
                  ? "Clipboard write failed. Try again or report the crash manually."
                  : "Copy the report and open a GitHub issue to help us fix this."}
            </text>
            <text fg={theme.text.muted}>Orchestra {app.version}</text>
          </box>
        </Show>
      </box>
    </box>
  )
}

function buildIssueURL(message: string, stack: string, version: string) {
  // Field keys match the ids in .github/ISSUE_TEMPLATE/bug-report.yml so the issue
  // form opens pre-filled. Populating os/terminal/reproduce keeps the report past
  // the contributing-guidelines compliance check, which pushes for system info.
  const url = new URL("https://github.com/NeiP4n/orchestra-app/issues/new?template=bug-report.yml")
  url.searchParams.set("title", `TUI crash: ${message}`)
  url.searchParams.set("orchestra-version", version)
  url.searchParams.set("os", describeOS())
  url.searchParams.set("terminal", describeTerminal())
  url.searchParams.set(
    "reproduce",
    "Reported automatically from the Orchestra crash screen. If you can, describe what you were doing when it crashed.",
  )

  // Budget the stack against the fully URL-encoded length (not the raw length) so
  // the final link stays under GitHub's practical limit; flag truncation so a
  // clipped trace is obvious. searchParams.set handles encoding without throwing,
  // so measuring url.toString() is both correct and safe on any input.
  const MAX_URL_LENGTH = 6000
  const marker = "\n… (truncated)"
  const head = `The Orchestra TUI crashed with an unexpected error.\n\n**Error:** ${message}\n\n**Stack trace:**\n`
  const setBody = (body: string) => url.searchParams.set("description", head + "```\n" + body + "\n```")

  setBody(stack)
  if (url.toString().length <= MAX_URL_LENGTH) return url

  // Largest raw stack prefix whose encoded URL (with the marker) still fits.
  let lo = 0
  let hi = stack.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    setBody(stack.slice(0, mid) + marker)
    if (url.toString().length <= MAX_URL_LENGTH) lo = mid
    else hi = mid - 1
  }
  setBody(stack.slice(0, lo) + marker)
  return url
}
