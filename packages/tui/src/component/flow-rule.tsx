import { createEffect, createMemo, createSignal, on, onCleanup, Show } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import { useConfig } from "../config"
import { useData } from "../context/data"
import { useTheme } from "../context/theme"
import { createRate, flowLabel, flowMode, flowPattern, flowSpeed, type FlowMode, type FlowSample } from "../effects/flow"

// One row above the prompt that says whether the model is alive: flashes on send, breathes while
// waiting, flows as fast as text arrives, blinks amber when nothing has come for too long, and
// dissolves after the answer. It takes no space when idle. See effects/flow.ts for the rules.
export function FlowRule(props: { sessionID: string }) {
  const data = useData()
  const config = useConfig().data
  const dimensions = useTerminalDimensions()
  const animated = () => (config.animations ?? true) && process.env.ORCHESTRA_NO_MOTION !== "1"

  const busy = () => data.session.status(props.sessionID) === "running"
  const messages = () => data.session.message.list(props.sessionID)
  // What counts as the answer growing: text and reasoning by length, every other step by a fixed amount.
  const size = createMemo(() => {
    const last = messages().at(-1)
    if (!last || last.type !== "assistant") return 0
    return last.content.reduce((total, part) => total + (part.type === "text" || part.type === "reasoning" ? part.text.length : 40), 0)
  })
  const sent = createMemo(() => messages().filter((message) => message.type === "user").length)

  const [now, setNow] = createSignal(Date.now())
  const [startedAt, setStartedAt] = createSignal<number>()
  const [sentAt, setSentAt] = createSignal<number>()
  const [lastGrowthAt, setLastGrowthAt] = createSignal<number>()
  const [finishedAt, setFinishedAt] = createSignal<number>()
  const [offset, setOffset] = createSignal(0)
  const [blink, setBlink] = createSignal(true)
  const rate = createRate()

  createEffect(
    on(
      busy,
      (running, was) => {
        const at = Date.now()
        setNow(at)
        if (running) {
          setStartedAt(at)
          setLastGrowthAt(undefined)
          setFinishedAt(undefined)
          rate.reset()
          rate.push(at, size())
        } else if (was) setFinishedAt(at)
      },
      { defer: true },
    ),
  )
  createEffect(
    on(
      sent,
      () => {
        const at = Date.now()
        setNow(at)
        setSentAt(at)
      },
      { defer: true },
    ),
  )
  createEffect(
    on(
      size,
      (value, was) => {
        if (!busy() || value === was) return
        const at = Date.now()
        setLastGrowthAt(at)
        rate.push(at, value)
      },
      { defer: true },
    ),
  )

  const sample = createMemo<FlowSample>(() => ({
    busy: busy(),
    now: now(),
    startedAt: startedAt(),
    sentAt: sentAt(),
    lastGrowthAt: lastGrowthAt(),
    finishedAt: finishedAt(),
  }))
  const mode = createMemo(() => flowMode(sample()))
  const perSecond = () => rate.perSecond(now())

  // The clock only runs while there is something to show, and only moves the pattern when animation is on.
  createEffect(() => {
    if (mode() === "idle") return
    let last = Date.now()
    let blinked = last
    const timer = setInterval(
      () => {
        const at = Date.now()
        setNow(at)
        if (animated()) {
          setOffset((value) => value + (flowSpeed(mode(), perSecond()) * (at - last)) / 1000)
          if (at - blinked >= 500) {
            setBlink((value) => !value)
            blinked = at
          }
        }
        last = at
      },
      animated() ? 80 : 1000,
    )
    onCleanup(() => clearInterval(timer))
  })

  const label = createMemo(() => flowLabel(mode(), sample(), perSecond()))
  const patternWidth = () => Math.max(6, Math.min(32, Math.floor(dimensions().width / 4)))

  return <FlowLine mode={mode()} label={label()} width={patternWidth()} offset={offset()} blink={blink()} />
}

// The painted row, kept apart from the clock so it can be rendered and tested on its own.
export function FlowLine(props: { mode: FlowMode; label: string; width: number; offset: number; blink: boolean }) {
  const theme = useTheme()
  const pattern = () => flowPattern(props.mode, props.width, props.offset, props.blink)
  const tone = () => (props.mode === "stalled" ? theme.text.feedback.warning.base : props.mode === "done" ? theme.text.muted : theme.hue.accent[200])
  return (
    <Show when={props.mode !== "idle"}>
      <box flexDirection="row" flexShrink={0} height={1} paddingLeft={3} gap={1}>
        <text fg={tone()} wrapMode="none">
          {pattern()}
        </text>
        <text fg={props.mode === "stalled" ? theme.text.feedback.warning.base : theme.text.muted} wrapMode="none">
          {props.label}
        </text>
      </box>
    </Show>
  )
}
