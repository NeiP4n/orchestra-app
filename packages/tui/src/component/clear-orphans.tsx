import { createSignal, Show } from "solid-js"
import { useTheme } from "../context/theme"
import { useT } from "../util/i18n"
import { hoverBackground, hoverForeground } from "../ui/hover"
import { cleanupErrorMessage } from "../util/backend-compatibility"

type CleanupApi = {
  prepare: (input: { currentSessionID?: string }) => Promise<{ token: string; count: number; definition: string }>
  confirm: (input: { token: string }) => Promise<{ removed: number; skipped: number; deleted: string[] }>
}
export function ClearOrphansAction(props: {
  local: boolean
  supported?: () => boolean | undefined
  api: CleanupApi
  currentSessionID?: string
  confirm: (options: { title: string; message: string; label: { confirm: string; cancel: string } }) => Promise<boolean | undefined>
  notify: (options: { message: string; variant: "info" | "success" | "warning" | "error"; duration?: number }) => void
  afterRemove?: (session: { id: string }) => Promise<void>
}) {
  const t = useT(), theme = useTheme()
  const [busy, setBusy] = createSignal(false), [hovered, setHovered] = createSignal(false)
  const clear = async () => {
    if (busy() || !props.local) return
    setBusy(true)
    try {
      if (props.supported?.() === false) { props.notify({ message: t("Cleanup is unavailable on this server. Update and restart the background server and TUI."), variant: "error", duration: 8000 }); return }
      const preview = await props.api.prepare({ currentSessionID: props.currentSessionID })
      if (!preview.count) { props.notify({ message: t("No orphan sessions found"), variant: "info" }); return }
      const yes = await props.confirm({ title: t("Clear orphan sessions"), message: t("Delete {count} idle orphan sessions whose parent no longer exists? Project, group, root, browser, archived and active chats are preserved. This cannot be undone.", { count: preview.count }), label: { confirm: t("Delete"), cancel: t("Cancel") } })
      if (!yes) return
      const result = await props.api.confirm({ token: preview.token })
      for (const id of result.deleted) await props.afterRemove?.({ id })
      props.notify({ message: t("Deleted {removed} orphan sessions; skipped {skipped}.", result), variant: result.skipped ? "warning" : "success", duration: 6000 })
    } catch (error) { props.notify({ message: t("Failed to clear sessions: {error}", { error: cleanupErrorMessage(error, t) }), variant: "error", duration: 6000 }) }
    finally { setBusy(false) }
  }
  return <Show when={props.local}><box id="project-tree.clear-orphans" flexShrink={0} paddingLeft={1} paddingRight={1}>
    <box id="project-tree.clear-orphans.action" backgroundColor={hovered() ? hoverBackground(theme, "destructive") : undefined} onMouseOver={() => setHovered(true)} onMouseOut={() => setHovered(false)} onMouseUp={event => { event.stopPropagation(); void clear() }}>
      <text fg={hovered() ? hoverForeground(theme, "destructive", theme.text.feedback.error.base) : theme.text.muted} wrapMode="none" truncate>{busy() ? t("Checking…") : t("Clear orphans")}</text>
    </box>
  </box></Show>
}
