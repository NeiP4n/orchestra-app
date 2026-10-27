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
import { render, type Focus, type Span, type Tone } from "../../widgets/render"
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

function isTargetSelected(widget: Widget, target: number): boolean {
  switch (widget.kind) {
    case "choice":
    case "confirm":
    case "buttons":
    case "diff":
    case "run":
      return widget.cursor === target
    case "multi":
      return target === -1 ? widget.cursor === widget.items.length : widget.cursor === target
    case "form":
      return target === widget.fields.length ? widget.cursor === widget.fields.length : widget.cursor === target
    case "rank":
      return target === -1 ? widget.cursor === widget.items.length : widget.cursor === target
    case "table":
    case "tree":
      return widget.select && widget.cursor === target
    case "scale":
      return target === -1 ? false : widget.value === target
    case "tabs":
      return widget.current === target
    default:
      return false
  }
}

function isRowOptionKind(kind: Widget["kind"]): boolean {
  return (
    kind === "choice" ||
    kind === "multi" ||
    kind === "form" ||
    kind === "rank" ||
    kind === "run" ||
    kind === "table" ||
    kind === "tree"
  )
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
  const [hoveredTarget, setHoveredTarget] = createSignal<number | undefined>(undefined)

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

  const handleActivate = (target: number) => {
    take()
    const result = activate(props.widget, target)
    settle(result.widget, result.outcome)
  }

  return (
    <box
      flexDirection="column"
      paddingLeft={3}
      paddingTop={1}
      flexShrink={0}
      position="relative"
      onMouseUp={take}
      onMouseOut={() => setHoveredTarget(undefined)}
    >
      {/* A branch from the conversation's nerve: interactive answers hang off it like the messages. */}
      <text position="absolute" left={1} top={1} fg={neuralPalette(theme).signal} selectable={false}>
        ├─
      </text>

      <Show
        when={props.widget.answered === undefined}
        fallback={
          <box flexDirection="row" alignItems="center" gap={1}>
            <text fg={theme.text.feedback.success.base} attributes={TextAttributes.BOLD} wrapMode="none">
              ✓
            </text>
            <Show when={props.widget.title}>
              <text fg={theme.text.muted} wrapMode="none">
                {props.widget.title} →
              </text>
            </Show>
            <box paddingLeft={1} paddingRight={1} backgroundColor={theme.background.raised.base}>
              <text fg={theme.text.formfield.selected} attributes={TextAttributes.BOLD} wrapMode="none">
                {props.widget.answered}
              </text>
            </box>
          </box>
        }
      >
        <For each={lines()}>
          {(line) => {
            const first = line[0]
            const isHeader = first?.text?.startsWith("╭")
            const isFooter = first?.text?.startsWith("╰")
            const isBody = first?.text?.startsWith("│")

            if (isHeader) {
              return (
                <box flexDirection="row" alignItems="center">
                  <text fg={color(first.tone)} attributes={attributes(first.tone)} wrapMode="none">
                    {first.text}
                  </text>
                  <For each={line.slice(1)}>
                    {(span) => (
                      <text
                        wrapMode="none"
                        fg={focus() === "active" ? theme.text.formfield.selected : theme.text.base}
                        attributes={focus() === "active" ? TextAttributes.BOLD : undefined}
                      >
                        {span.text}
                      </text>
                    )}
                  </For>
                </box>
              )
            }

            if (isFooter) {
              return (
                <box flexDirection="row" alignItems="center">
                  <text fg={color(first.tone)} attributes={attributes(first.tone)} wrapMode="none">
                    {first.text}
                  </text>
                  <For each={line.slice(1)}>
                    {(span) => (
                      <text wrapMode="none" fg={color(span.tone)} attributes={attributes(span.tone)}>
                        {span.text}
                      </text>
                    )}
                  </For>
                </box>
              )
            }

            if (isBody) {
              const rest = line.slice(1)
              const targets = rest.flatMap((s) => (s.target !== undefined ? [s.target] : []))
              const uniqueTargets = [...new Set(targets)]
              const singleTarget = uniqueTargets.length === 1 ? uniqueTargets[0] : undefined
              const isRowOption =
                singleTarget !== undefined &&
                isRowOptionKind(props.widget.kind) &&
                singleTarget !== -1 &&
                !(props.widget.kind === "form" && singleTarget === props.widget.fields.length)

              return (
                <box flexDirection="row" alignItems="center">
                  <text fg={color(first.tone)} attributes={attributes(first.tone)} wrapMode="none">
                    {first.text}
                  </text>

                  <Show
                    when={!isRowOption}
                    fallback={
                      (() => {
                        const target = singleTarget as number
                        const isHover = () => props.live && hoveredTarget() === target
                        const isSelected = () => isTargetSelected(props.widget, target)
                        const rowBg = () => {
                          if (isHover()) return theme.background.formfield.hovered ?? theme.background.formfield.selected
                          if (isSelected()) return mine() ? theme.background.formfield.focused : theme.background.formfield.selected
                          return undefined
                        }
                        const spanFg = (span: Span) => {
                          if (isHover()) return theme.text.formfield.hovered ?? theme.text.formfield.selected
                          if (isSelected()) return mine() ? theme.text.formfield.focused : theme.text.formfield.selected
                          return color(span.tone)
                        }
                        const spanAttr = (span: Span) => {
                          if (isHover() || isSelected()) return TextAttributes.BOLD
                          return attributes(span.tone)
                        }

                        return (
                          <box
                            flexDirection="row"
                            alignItems="center"
                            paddingLeft={1}
                            paddingRight={1}
                            backgroundColor={rowBg()}
                            onMouseOver={() => {
                              if (props.live) setHoveredTarget(target)
                            }}
                            onMouseOut={() => {
                              if (hoveredTarget() === target) setHoveredTarget(undefined)
                            }}
                            onMouseUp={(event) => {
                              event.stopPropagation()
                              handleActivate(target)
                            }}
                          >
                            <For each={rest}>
                              {(span) => (
                                <text wrapMode="none" fg={spanFg(span)} attributes={spanAttr(span)}>
                                  {span.text}
                                </text>
                              )}
                            </For>
                          </box>
                        )
                      })()
                    }
                  >
                    <Show
                      when={uniqueTargets.length > 0}
                      fallback={
                        <box flexDirection="row" paddingLeft={1}>
                          <For each={rest}>
                            {(span) => (
                              <text wrapMode="none" fg={color(span.tone)} attributes={attributes(span.tone)}>
                                {span.text}
                              </text>
                            )}
                          </For>
                        </box>
                      }
                    >
                      <box flexDirection="row" alignItems="center" paddingLeft={1} gap={1}>
                        <For each={rest}>
                          {(span) => {
                            if (span.target !== undefined) {
                              const target = span.target
                              const isHover = () => props.live && hoveredTarget() === target
                              const isSelected = () => isTargetSelected(props.widget, target)
                              const btnBg = () => {
                                if (isHover()) return theme.background.formfield.hovered ?? theme.background.formfield.selected
                                if (isSelected()) return mine() ? theme.background.formfield.focused : theme.background.formfield.selected
                                return theme.background.raised.base
                              }
                              const btnFg = () => {
                                if (isHover()) return theme.text.formfield.hovered ?? theme.text.formfield.selected
                                if (isSelected()) return mine() ? theme.text.formfield.focused : theme.text.formfield.selected
                                return theme.text.formfield.base
                              }

                              return (
                                <box
                                  paddingLeft={1}
                                  paddingRight={1}
                                  backgroundColor={btnBg()}
                                  onMouseOver={() => {
                                    if (props.live) setHoveredTarget(target)
                                  }}
                                  onMouseOut={() => {
                                    if (hoveredTarget() === target) setHoveredTarget(undefined)
                                  }}
                                  onMouseUp={(event) => {
                                    event.stopPropagation()
                                    handleActivate(target)
                                  }}
                                >
                                  <text
                                    wrapMode="none"
                                    fg={btnFg()}
                                    attributes={isHover() || isSelected() ? TextAttributes.BOLD : undefined}
                                  >
                                    {span.text}
                                  </text>
                                </box>
                              )
                            }
                            if (!span.text.trim()) return null
                            return (
                              <text wrapMode="none" fg={color(span.tone)} attributes={attributes(span.tone)}>
                                {span.text}
                              </text>
                            )
                          }}
                        </For>
                      </box>
                    </Show>
                  </Show>
                </box>
              )
            }

            return (
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
                        paddingLeft={1}
                        paddingRight={1}
                        onMouseOver={() => {
                          if (props.live) setHoveredTarget(span.target)
                        }}
                        onMouseOut={() => {
                          if (hoveredTarget() === span.target) setHoveredTarget(undefined)
                        }}
                        onMouseUp={(event) => {
                          event.stopPropagation()
                          handleActivate(span.target as number)
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
            )
          }}
        </For>
      </Show>
    </box>
  )
}
