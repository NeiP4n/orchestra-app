import { createEffect, createMemo, createSignal, onMount, onCleanup, For } from "solid-js"
import { useMotion } from "@orchestra/ui/neural-field"
import { tuiAudioBands } from "./audio-bands"
import { useData } from "@/runtime/server/current"
import { useLanguage } from "@/runtime/i18n/language"

// TUI header order: title on the left, real activity and eight bands on the right.
export function TuiSessionStatus(props: { sessionID?: string }) {
  const data = useData()
  const language = useLanguage()

  const running = createMemo(() => {
    const id = props.sessionID

    return (
      !!id &&
      (data.session.status(id) === "running" ||
        data.session.list().some((session) => session.parentID === id && data.session.status(session.id) === "running"))
    )
  })

  const motion = useMotion()
  const [visible, setVisible] = createSignal(true)
  const [tick, setTick] = createSignal(0)

  onMount(() => {
    const update = () => setVisible(!document.hidden)
    update()
    document.addEventListener("visibilitychange", update)
    onCleanup(() => document.removeEventListener("visibilitychange", update))
  })
  createEffect(() => {
    if (!running() || !motion() || !visible()) return
    const timer = setInterval(() => setTick((value) => (value + 1) % 10000), 33)

    onCleanup(() => clearInterval(timer))
  })
  const bands = createMemo(() => tuiAudioBands(running() && motion(), tick()))

  return (
    <div
      data-component="tui-session-status"
      data-running={running()}
      role="status"
      class="flex shrink-0 items-center gap-2 text-12-regular text-v2-text-text-muted"
    >
      <span>{language.t(running() ? "session.timeline.working" : "session.tui.ready")}</span>
      <span data-slot="tui-header-bands" aria-hidden="true">
        <For each={bands()}>{(level) => <span style={{ "--band-rest": String(level) }} />}</For>
      </span>
    </div>
  )
}
