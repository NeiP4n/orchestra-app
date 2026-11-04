import { useTheme } from "../context/theme"
import { useData } from "../context/data"
import { For, Match, Switch, Show, createMemo } from "solid-js"
import { DialogHeader, DialogShell } from "./dialog-standard"
import { useT } from "../util/i18n"

export function DialogStatus() {
  const data = useData()
  const theme = useTheme().surface("dialog")
  const t = useT()

  const mcp = createMemo(() => data.location.mcp.server.list() ?? [])
  const color = (status: string) => {
    if (status === "connected") return theme.text.feedback.success.base
    if (status === "failed") return theme.text.feedback.error.base
    if (status === "needs_auth") return theme.text.feedback.warning.base
    return theme.text.muted
  }
  return (
    <DialogShell>
      <DialogHeader title={t("Status")} />
      <Show when={mcp().length > 0} fallback={<text fg={theme.text.base}>{t("No MCP servers")}</text>}>
        <box>
          <text fg={theme.text.base}>{t("{count} MCP server(s)", { count: mcp().length })}</text>
          <For each={mcp()}>
            {(item) => (
              <box flexDirection="row" gap={1}>
                <text flexShrink={0} style={{ fg: color(item.status.status) }}>
                  •
                </text>
                <text fg={theme.text.base} wrapMode="word">
                  <b>{item.name}</b>{" "}
                  <span style={{ fg: theme.text.muted }}>
                    <Switch fallback={item.status.status}>
                      <Match when={item.status.status === "connected"}>{t("Connected")}</Match>
                      <Match when={item.status.status === "failed" && item.status}>{(val) => val().error}</Match>
                      <Match when={item.status.status === "disabled"}>{t("Disabled in configuration")}</Match>
                      <Match when={item.status.status === "needs_auth" && item.status}>
                        {(val) => t("Needs authentication: {error}", { error: val().error ?? "" })}
                      </Match>
                    </Switch>
                  </span>
                </text>
              </box>
            )}
          </For>
        </box>
      </Show>
    </DialogShell>
  )
}
