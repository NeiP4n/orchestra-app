import { createMemo, For } from "solid-js"
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

  return (
    <div
      data-component="tui-session-status"
      data-running={running()}
      role="status"
      class="flex shrink-0 items-center gap-2 text-12-regular text-v2-text-text-muted"
    >
      <span>{language.t(running() ? "session.timeline.working" : "neural.status.ready")}</span>
      <span data-slot="tui-header-bands" aria-hidden="true">
        <For each={[0.08, 0.12, 0.16, 0.2, 0.2, 0.16, 0.12, 0.08]}>
          {(level, index) => <span style={{ "--band-rest": String(level), "animation-delay": `${index() * -83}ms` }} />}
        </For>
      </span>
    </div>
  )
}
