import { Plugin } from "@orchestra/plugin/tui"
import { TextAttributes } from "@opentui/core"
import { createMemo, createResource, createSignal, For, Show } from "solid-js"
import { HoverAction } from "../../component/hover-action"
import { useClient } from "../../context/client"
import { contextUsage } from "../../util/session"
import {
  barCells,
  contextBreakdown,
  heaviestFirst,
  kinds,
  scopes,
  sumOf,
  total,
  type Scope,
} from "../../util/context-scope"
import { loadScope } from "../../util/context-scope-load"
import { Locale } from "../../util/locale"
import { useCompactLayout } from "../../ui/compact-layout"
import { useT } from "../../util/i18n"
import { DOD_PANEL, SidebarDod, SidebarDodPanel } from "./dod"

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
})

const MAX_ENTRIES = 8

const scopeLabel = { session: "Session", project: "Project", group: "Group" } as const

export function SidebarContext(props: { context: Plugin.Context; sessionID: string }) {
  const theme = props.context.theme
  const t = useT()
  const layout = useCompactLayout()
  const client = useClient()
  const [scope, setScope] = createSignal<Scope>("session")
  // The sidebar's side padding (2 + 2, or 1 + 1 when compact) plus the column reserved for the scrollbar.
  const barWidth = () => Math.max(1, layout.sidebarWidth() - (layout.compact() ? 3 : 5))
  const msg = createMemo(() => props.context.data.session.message.list(props.sessionID))
  const session = createMemo(() => props.context.data.session.get(props.sessionID))
  const cost = createMemo(() => props.context.data.session.cost(props.sessionID))

  const state = createMemo(() =>
    contextUsage(msg(), props.context.data.location.model.list(session()?.location), session()?.revert?.messageID),
  )
  const held = createMemo(() => contextBreakdown(msg(), session()?.revert?.messageID))
  // A nearly full window is about to compact, which is worth flagging as status feedback.
  const level = (percent: number) => {
    if (percent >= 90) return theme.text.feedback.error.base
    if (percent >= 75) return theme.text.feedback.warning.base
    return theme.text.base
  }

  // A project or group adds up what its sessions used; it loads again when this session does new work.
  const key = createMemo(() => {
    const current = scope()
    if (current === "session") return
    return { scope: current, sessionID: props.sessionID, directory: session()?.location.directory, rev: msg().length }
  })
  const [scoped] = createResource(key, (value) =>
    loadScope({ api: client.api, ...value, signal: new AbortController().signal }).catch(() => undefined),
  )
  const ready = () => {
    const result = scoped.latest
    return result?.state === "ready" ? result : undefined
  }
  const entries = createMemo(() => heaviestFirst(ready()?.entries ?? []))
  const sum = createMemo(() => total(entries()))

  // What the bar measures: the model's window for a session, the scope's own token total otherwise.
  const bar = createMemo(() => {
    if (scope() === "session") {
      const tokens = held()
      const used = state()?.tokens ?? 0
      return tokens && used > 0 ? { tokens, used, whole: state()?.limit ?? used } : undefined
    }
    const used = sumOf(sum().tokens)
    return used > 0 ? { tokens: sum().tokens, used, whole: used } : undefined
  })
  const spent = () => (scope() === "session" ? cost() : sum().cost)
  const share = (count: number, whole: number) => (whole > 0 ? `${((count / whole) * 100).toFixed(1)}%` : "")

  return (
    <>
      <SidebarDod context={props.context} sessionID={props.sessionID} />
      <box>
        <box flexDirection="row" justifyContent="space-between">
          <text fg={theme.text.base}>
            <b>{t("Context")}</b>
          </text>
          <Show when={scope() === "session" && state()?.percent}>
            {(percent) => <text fg={level(percent())}>{t("{percent}% used", { percent: percent() })}</text>}
          </Show>
        </box>
        <box flexDirection="row" gap={1}>
          <For each={scopes}>
            {(item) => (
              <HoverAction id={`sidebar.context.${item}`} onClick={() => setScope(item)} paddingRight={1}>
                <text
                  fg={scope() === item ? theme.text.base : theme.text.muted}
                  attributes={scope() === item ? TextAttributes.BOLD | TextAttributes.UNDERLINE : undefined}
                >
                  {t(scopeLabel[item])}
                </text>
              </HoverAction>
            )}
          </For>
        </box>
        <Show when={scope() !== "session" && scoped.loading && !scoped.latest}>
          <text fg={theme.text.muted}>{t("Loading usage…")}</text>
        </Show>
        <Show when={scope() !== "session" && !scoped.loading && scoped.latest === undefined}>
          <text fg={theme.text.muted}>{t("Could not load usage for this scope.")}</text>
        </Show>
        <Show when={scope() !== "session" && scoped.latest?.state === "no-project"}>
          <text fg={theme.text.muted}>{t("This session does not belong to a project.")}</text>
        </Show>
        <Show when={scope() !== "session" && scoped.latest?.state === "no-group"}>
          <text fg={theme.text.muted}>{t("This session's project is not in a group.")}</text>
        </Show>
        <Show when={bar()}>
          {(item) => {
            const cells = () => barCells(item().tokens, item().whole, barWidth())
            return (
              <>
                <Show when={scope() !== "session" && ready()}>
                  {(result) => (
                    <text fg={theme.text.base} wrapMode="none">
                      {Locale.truncate(result().title, barWidth())}
                    </text>
                  )}
                </Show>
                <text wrapMode="none">
                  <For each={cells()}>
                    {(part) => (
                      <span style={{ fg: scope() === "session" ? level(state()?.percent ?? 0) : theme.text.base }}>
                        {part.kind.glyph.repeat(part.cells)}
                      </span>
                    )}
                  </For>
                  <span style={{ fg: theme.text.muted }}>
                    {"·".repeat(Math.max(0, barWidth() - cells().reduce((count, part) => count + part.cells, 0)))}
                  </span>
                </text>
                <box flexDirection="row" justifyContent="space-between" gap={1}>
                  <text fg={theme.text.muted} wrapMode="none">
                    {Locale.number(item().used)}
                    <Show when={scope() === "session" && state()?.limit}>
                      {(limit) => ` / ${Locale.number(limit())}`}
                    </Show>{" "}
                    {t("tokens")}
                  </text>
                  <Show when={spent() > 0}>
                    <text fg={theme.text.muted} wrapMode="none" flexShrink={0}>
                      {t("{cost} spent", { cost: money.format(spent()) })}
                    </text>
                  </Show>
                </box>
                <For each={kinds.filter((kind) => item().tokens[kind.id] > 0)}>
                  {(kind) => (
                    <box flexDirection="row" gap={1}>
                      <text fg={theme.text.muted}>{kind.glyph}</text>
                      <text fg={theme.text.base} flexGrow={1} wrapMode="none">
                        {t(kind.label)}
                      </text>
                      <text fg={theme.text.muted} wrapMode="none">
                        {Locale.number(item().tokens[kind.id])}
                      </text>
                      <text fg={theme.text.base} wrapMode="none">
                        {share(item().tokens[kind.id], item().whole).padStart(6)}
                      </text>
                    </box>
                  )}
                </For>
                <Show when={scope() === "session" && state()?.limit && item().whole > item().used}>
                  <box flexDirection="row" gap={1}>
                    <text fg={theme.text.muted}>·</text>
                    <text fg={theme.text.base} flexGrow={1} wrapMode="none">
                      {t("Free space")}
                    </text>
                    <text fg={theme.text.muted} wrapMode="none">
                      {Locale.number(item().whole - item().used)}
                    </text>
                    <text fg={theme.text.base} wrapMode="none">
                      {share(item().whole - item().used, item().whole).padStart(6)}
                    </text>
                  </box>
                </Show>
                <Show when={scope() !== "session" && entries().length > 0}>
                  <box paddingTop={1}>
                    <text fg={theme.text.muted}>
                      {t(scope() === "project" ? "Sessions in this project" : "Projects in this group")}
                    </text>
                    <For each={entries().slice(0, MAX_ENTRIES)}>
                      {(entry) => (
                        <box flexDirection="row" gap={1}>
                          <text fg={theme.text.base} flexGrow={1} wrapMode="none">
                            {Locale.truncate(entry.title, Math.max(4, barWidth() - 8))}
                          </text>
                          <text fg={theme.text.muted} wrapMode="none">
                            {Locale.number(sumOf(entry.tokens))}
                          </text>
                        </box>
                      )}
                    </For>
                    <Show when={entries().length > MAX_ENTRIES}>
                      <text fg={theme.text.muted}>{t("+{count} more", { count: entries().length - MAX_ENTRIES })}</text>
                    </Show>
                  </box>
                </Show>
              </>
            )
          }}
        </Show>
        <Show when={!bar() && scope() === "session" && cost() > 0}>
          <text fg={theme.text.muted} wrapMode="none">
            {t("{cost} spent", { cost: money.format(cost()) })}
          </text>
        </Show>
      </box>
    </>
  )
}

export default Plugin.define({
  id: "opencode.sidebar.context",
  setup(context) {
    context.ui.slot({
      append: "sidebar.content",
      render: (props) => <SidebarContext context={context} sessionID={props.sessionID} />,
    })
    context.ui.slot({
      append: "session.panel",
      render: (panel) => (
        <Show when={panel.name === DOD_PANEL}>
          <SidebarDodPanel context={context} panel={panel} />
        </Show>
      ),
    })
  },
})
