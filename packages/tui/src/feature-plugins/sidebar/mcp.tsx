import { Plugin } from "@orchestra/plugin/tui"
import { createEffect, createMemo, createResource, createSignal, For, Match, onCleanup, Show, Switch } from "solid-js"
import { Orchestra } from "@orchestra/schema/orchestra"
import { DialogMcp } from "../../component/dialog-mcp"
import { useClient } from "../../context/client"
import { useT } from "../../util/i18n"
import { hoverBackground } from "../../ui/hover"
import { assignmentOf, assignmentSummary, sessionMcpView, teamMcpView, teamWorkerLine } from "./mcp-model"

// The sidebar's MCP panel answers "what was THIS session granted, and what did
// the Orchestrator grant its workers?" — from the per-session assignment
// records stamped at dispatch time. The global server inventory is NOT an
// assignment: it appears here only as one compact row (with attention counts
// always visible) that opens the MCP manager dialog, which keeps the full
// inventory. Rows are display only: clicking one opens the manager for that
// server and never grants or changes any session's access.
export function SidebarMcp(props: { context: Plugin.Context; sessionID: string }) {
  const [view, updateView] = props.context.storage.store("view", { initial: { teamOpen: true } })
  const theme = props.context.theme
  const t = useT()
  const client = useClient()
  const session = createMemo(() => props.context.data.session.get(props.sessionID))
  const list = createMemo(() => props.context.data.location.mcp.server.list(session()?.location) ?? [])
  const global = createMemo(() => list().map((item) => ({ name: item.name, status: item.status.status })))
  const mine = createMemo(() => sessionMcpView(assignmentOf(session()?.metadata), global()))
  const count = (status: string) => list().filter((item) => item.status.status === status).length

  // Team assignments: only the main Orchestrator session shows them, and only
  // its own project's sessions (fetched from that project's session list), so
  // nothing leaks across project boundaries.
  const projectID = createMemo(() => {
    const current = session()
    return current?.agent === "orchestrator" ? Orchestra.sessionOwner(current.metadata) : undefined
  })
  const [teamSessions, { refetch: refetchTeam }] = createResource(projectID, (id) =>
    client.api.orchestra.project
      .sessions({ projectID: id })
      .then((result) => result.data)
      .catch(() => []),
  )
  const team = createMemo(() => teamMcpView(teamSessions() ?? [], props.sessionID, global()))
  const myRows = createMemo(() => {
    const current = mine()
    // An unrestricted grant ("all") is a summary, not a list: expanding it here
    // would dump the whole global inventory under THIS SESSION and read as if
    // every server were individually assigned. Rows are for finite grants —
    // the servers the Orchestrator actually named for this session.
    return current.kind === "assigned" && !current.unrestricted ? current.rows : []
  })
  const roleDefault = createMemo(() => {
    const current = mine()
    return current.kind === "assigned" && !current.explicit
  })
  createEffect(() => {
    if (!view.teamOpen || !projectID()) return
    void refetchTeam()
    const timer = setInterval(() => void refetchTeam(), 10_000)
    onCleanup(() => clearInterval(timer))
  })

  const dot = (status: string) => {
    if (status === "connected") return theme.text.feedback.success.base
    if (status === "failed") return theme.text.feedback.error.base
    if (status === "needs_auth") return theme.text.feedback.warning.base
    return theme.text.muted
  }
  const statusColor = (status: string) => {
    if (status === "failed") return theme.text.feedback.error.base
    if (status === "needs_auth") return theme.text.feedback.warning.base
    return theme.text.muted
  }

  return (
    <box>
      <box flexDirection="row" justifyContent="space-between" gap={1}>
        <text fg={theme.text.base} flexShrink={0}>
          <b>{t("MCP · THIS SESSION")}</b>
        </text>
        <text fg={theme.text.muted} wrapMode="none">
          {assignmentSummary(mine())}
        </text>
      </box>
      <Show when={roleDefault()}>
        <text fg={theme.text.muted} wrapMode="none">
          {t("Role default — not explicitly assigned")}
        </text>
      </Show>
      <Show when={myRows().length > 0}>
        <For each={myRows()}>
          {(row) => {
            const [hovered, setHovered] = createSignal(false)
            return (
              <box
                flexDirection="row"
                gap={1}
                minWidth={0}
                backgroundColor={hovered() ? hoverBackground(theme) : undefined}
                onMouseOver={() => setHovered(true)}
                onMouseOut={() => setHovered(false)}
                onMouseUp={() =>
                  props.context.ui.dialog.show(() => (
                    <DialogMcp initialServer={row.name} details={row.status === "failed"} />
                  ))
                }
              >
                <text flexShrink={0} style={{ fg: dot(row.status) }}>
                  •
                </text>
                <text fg={theme.text.base} wrapMode="none" truncate flexGrow={1} flexShrink={1} minWidth={0}>
                  <b>{row.name}</b>
                </text>
                <text fg={statusColor(row.status)} wrapMode="none" flexShrink={0}>
                  <Switch fallback={row.status}>
                    <Match when={row.status === "connected"}>{t("Connected")}</Match>
                    <Match when={row.status === "pending"}>{t("Connecting")}</Match>
                    <Match when={row.status === "failed"}>{t("Error")}</Match>
                    <Match when={row.status === "disabled"}>{t("Disabled")}</Match>
                    <Match when={row.status === "needs_auth"}>{t("Needs sign-in")}</Match>
                    <Match when={row.status === "unknown"}>{t("Not connected")}</Match>
                  </Switch>
                </text>
              </box>
            )
          }}
        </For>
      </Show>

      <Show when={team().length > 0}>
        <box
          flexDirection="row"
          gap={1}
          onMouseDown={() => {
            void updateView((draft) => {
              draft.teamOpen = !draft.teamOpen
            }).catch((error) => console.error("Failed to persist MCP sidebar state", error))
          }}
        >
          <text fg={theme.text.base} flexShrink={0}>
            {view.teamOpen ? "▼ " : "▶ "}
            <b>{t("Team MCP assignments")}</b>
          </text>
          <text fg={theme.text.muted} wrapMode="none">
            {t("{count} workers", { count: team().length })}
          </text>
        </box>
        <Show when={view.teamOpen}>
          <For each={team()}>
            {(worker) => (
              <box>
                <text fg={theme.text.base} wrapMode="none" truncate>
                  {teamWorkerLine(worker)}
                </text>
                <Show when={worker.view.kind === "assigned" && !worker.view.unrestricted}>
                  <For each={worker.view.kind === "assigned" ? worker.view.rows : []}>
                    {(row) => (
                      <text fg={theme.text.muted} wrapMode="none" truncate>
                        {"  "}
                        {row.name}
                        {row.usable ? "" : ` · ${row.status === "needs_auth" ? t("Needs sign-in") : row.status === "failed" ? t("Error") : t("Not connected")}`}
                      </text>
                    )}
                  </For>
                </Show>
                <Show when={worker.view.kind === "none"}>
                  <text fg={theme.text.muted} wrapMode="none">
                    {"  "}
                    {t("None")}
                  </text>
                </Show>
              </box>
            )}
          </For>
        </Show>
      </Show>

      <Show when={list().length > 0}>
        <box
          flexDirection="row"
          justifyContent="space-between"
          gap={1}
          onMouseUp={() => props.context.ui.dialog.show(() => <DialogMcp />)}
        >
          <text fg={theme.text.muted} flexShrink={0}>
            {t("All MCP servers")}
          </text>
          <text wrapMode="none">
            <span style={{ fg: theme.text.muted }}>
              {t("{count}/{total} connected", { count: count("connected"), total: list().length })}
            </span>
            <Show when={count("failed") > 0}>
              <span style={{ fg: theme.text.feedback.error.base }}> · {t("{count} failed", { count: count("failed") })}</span>
            </Show>
            <Show when={count("needs_auth") > 0}>
              <span style={{ fg: theme.text.feedback.warning.base }}>
                {" "}
                · {t("{count} need sign in", { count: count("needs_auth") })}
              </span>
            </Show>
          </text>
        </box>
      </Show>
    </box>
  )
}

export default Plugin.define({
  id: "orchestra.sidebar.mcp",
  setup(context) {
    context.ui.slot({
      append: "sidebar.content",
      render: (props) => <SidebarMcp context={context} sessionID={props.sessionID} />,
    })
  },
})
