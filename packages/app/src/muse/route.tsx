import { Show, createSignal } from "solid-js"
import { useLanguage } from "@/runtime/i18n/language"
import { useGlobal } from "@/runtime/server/runtime"
import { ServerConnection, useServers } from "@/runtime/server/registry"
import { useLayout } from "@/shell/state/layout"
import { useTabs } from "@/shell/tabs/tabs"

// Dedicated Muse chat panel. This is a separate chat, like the browser
// chat with Muse, not another tab of a normal session: opening it starts
// a draft pinned to the meta provider's muse-spark-1.3 model, and that
// draft becomes the Muse session. The Muse session runs on the same
// Orchestra server as everything else, and through the muse-chat tools
// it can manage that Orchestra: list agents, create sessions, send them
// prompts, and switch their agent or model. The panel itself does not
// call the model directly; the draft composer does, so the chat keeps
// Orchestra's normal session, permission and tool behaviour.
export function MuseRoute() {
  const language = useLanguage()
  const global = useGlobal()
  const servers = useServers()
  const layout = useLayout()
  const tabs = useTabs()
  const [error, setError] = createSignal<string | undefined>(undefined)

  const openMuseChat = () => {
    setError(undefined)

    const conn = servers.visible.find(
      (item) => ServerConnection.key(item) === layout.home.selection().server,
    ) ?? servers.visible[0]

    if (!conn) {
      setError(language.t("muse.noServer"))

      return
    }

    const directory =
      layout.home.selection().directory ||
      global.ensureServerCtx(conn).projects.list()[0]?.worktree

    if (!directory) {
      setError(language.t("muse.noProject"))

      return
    }

    void tabs
      .newDraft(
        { server: ServerConnection.key(conn), directory },
        "",
        { providerID: "meta", modelID: "muse-spark-1.3", variant: null },
      )
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause))
      })
  }

  return (
    <div data-slot="muse-panel" class="flex min-h-0 flex-1 flex-col gap-4 px-4 py-4">
      <h1 class="text-v2-text-text-base text-lg font-semibold">{language.t("muse.title")}</h1>
      <p class="text-v2-text-text-muted">{language.t("muse.description")}</p>
      <p class="text-v2-text-text-muted">{language.t("muse.tools")}</p>
      <div>
        <button type="button" onClick={openMuseChat}>
          {language.t("muse.openChat")}
        </button>
      </div>
      <Show when={error()}>
        <p class="text-v2-text-text-muted">{error()}</p>
      </Show>
      <p class="text-v2-text-text-muted">{language.t("muse.keyNote")}</p>
    </div>
  )
}
