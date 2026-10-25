import { tr } from "../../util/i18n"
import { TextAttributes, type RGBA } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { createMemo, createSignal, For, Show } from "solid-js"
import { useClipboard } from "../../context/clipboard"
import { neuralPalette } from "../../component/neural"
import { useTheme } from "../../context/theme"
import { useToast } from "../../ui/toast"
import { usePromptRef } from "../../context/prompt"
import { activate, needsAnswer, press, reply, type Key, type Outcome } from "../../widgets/press"
import { render, type Focus, type Tone } from "../../widgets/render"
import type { Widget } from "../../widgets/parse"
import { useQuickSend } from "./society"

// The element that currently owns the keyboard, shared by every message in the chat.
const [owner, setOwner] = createSignal<string>()

function keyOf(event: { name: string; sequence?: string; shift?: boolean }): Key | undefined {
  switch (event.name) {
    case "up":
    case "down":
    case "left":
    case "right":
    case "tab":
    case "backspace":
      return event.name === "tab" && event.shift ? "backtab" : event.name
    case "return":
    case "enter":
      return "enter"
    case "escape":
      return "esc"
    case "space":
      return " "
  }
  const typed = event.sequence ?? event.name
  return [...typed].length === 1 ? typed : undefined
}

// One interactive element of an assistant message. Clicking a part of it acts on that part,
// clicking anywhere else gives it the keyboard; the answer goes back to the model as a normal message.
export function WidgetBlock(props: { id: string; widget: Widget; width: number; live: boolean; onChange: (widget: Widget) => void }) {
  const theme = useTheme()
  const send = useQuickSend()
  const clipboard = useClipboard()
  const toast = useToast()
  const promptRef = usePromptRef()
  const mine = () => owner() === props.id
  const waiting = () => props.live && needsAnswer(props.widget) && props.widget.answered === undefined
  const focus = (): Focus => (mine() ? "active" : waiting() ? "pending" : "idle")
  const lines = createMemo(() => render(props.widget, props.width, focus()))

  const color = (tone: Tone): RGBA => {
    switch (tone) {
      case "accent":
      case "accentBold":
        return theme.text.formfield.selected
      case "dim":
        return theme.text.muted
      case "warn":
      case "warnBold":
        return theme.text.feedback.warning.base
      default:
        return theme.text.base
    }
  }
  const attributes = (tone: Tone) => (tone === "accentBold" || tone === "warnBold" ? TextAttributes.BOLD : undefined)

  const settle = (next: Widget, outcome: Outcome) => {
    props.onChange(next)
    switch (outcome.type) {
      case "answer":
        setOwner(undefined)
        promptRef.current?.focus()
        send(reply(next, outcome.value))
        return
      case "copy":
        void clipboard.write(outcome.text).then(() => toast.show({ message: tr("Copied"), variant: "info" }))
        return
      case "release":
        setOwner(undefined)
        promptRef.current?.focus()
        return
      case "focus-prompt":
        setOwner(undefined)
        promptRef.current?.focus()
        return
      case "none":
        return
    }
  }

  const take = () => {
    if (!props.live) return
    setOwner(props.id)
    promptRef.current?.blur()
  }

  useKeyboard((event) => {
    if (!mine() || !props.live) return
    const key = keyOf(event)
    if (key === undefined) return
    event.preventDefault()
    event.stopPropagation()
    const result = press(props.widget, key)
    settle(result.widget, result.outcome)
  })

  return (
    <box flexDirection="column" paddingLeft={3} paddingTop={1} flexShrink={0} position="relative" onMouseUp={take}>
      {/* A branch from the conversation's nerve: interactive answers hang off it like the messages. */}
      <text position="absolute" left={1} top={1} fg={neuralPalette(theme).signal} selectable={false}>
        ├─
      </text>
      <For each={lines()}>
        {(line) => (
          <box flexDirection="row">
            <For each={line}>
              {(span) => (
                <Show
                  when={span.target !== undefined && props.live}
                  fallback={
                    <text wrapMode="none" fg={color(span.tone)} attributes={attributes(span.tone)}>
                      {span.text}
                    </text>
                  }
                >
                  <box
                    onMouseUp={(event) => {
                      event.stopPropagation()
                      take()
                      const result = activate(props.widget, span.target as number)
                      settle(result.widget, result.outcome)
                    }}
                  >
                    <text wrapMode="none" fg={color(span.tone)} attributes={attributes(span.tone)}>
                      {span.text}
                    </text>
                  </box>
                </Show>
              )}
            </For>
          </box>
        )}
      </For>
    </box>
  )
}
