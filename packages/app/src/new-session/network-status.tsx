import { createMemo, Show } from "solid-js"
import { NeuralDot } from "@orchestra/ui/neural-field"
import { useData, useServer } from "@/runtime/server/current"
import { useLanguage } from "@/runtime/i18n/language"

// Same position and live meaning as the TUI's BrainStatus, without creating a Session.
export function NewSessionNetworkStatus() {
  const data = useData()
  const server = useServer()
  const language = useLanguage()
  const connected = () => server.ctx.sdk.connection.status() === "connected"

  const running = createMemo(() =>
    data.session.list().filter((session) => !session.parentID && data.session.status(session.id) === "running"),
  )

  return (
    <div
      data-component="new-session-network-status"
      class="flex min-h-5 items-center justify-center gap-2 text-12-regular text-v2-text-text-muted"
    >
      <NeuralDot />
      <Show when={connected()} fallback={language.t("neural.status.connecting")}>
        <Show when={running().length > 0} fallback={language.t("neural.status.ready")}>
          {language.plural("session.running.running", running().length)}
        </Show>
      </Show>
    </div>
  )
}
