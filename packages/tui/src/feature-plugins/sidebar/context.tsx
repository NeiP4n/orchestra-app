import { Plugin } from "@orchestra/plugin/tui"
import { createMemo, Show } from "solid-js"
import { contextUsage } from "../../util/session"
import { Locale } from "../../util/locale"
import { useCompactLayout } from "../../ui/compact-layout"
import { useT } from "../../util/i18n"
import { DOD_PANEL, SidebarDod, SidebarDodPanel } from "./dod"

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
})

export function SidebarContext(props: { context: Plugin.Context; sessionID: string }) {
  const theme = props.context.theme
  const t = useT()
  const layout = useCompactLayout()
  // The sidebar's side padding (2 + 2, or 1 + 1 when compact) plus the column reserved for the scrollbar.
  const barWidth = () => Math.max(1, layout.sidebarWidth() - (layout.compact() ? 3 : 5))
  const msg = createMemo(() => props.context.data.session.message.list(props.sessionID))
  const session = createMemo(() => props.context.data.session.get(props.sessionID))
  const cost = createMemo(() => props.context.data.session.cost(props.sessionID))

  const state = createMemo(() =>
    contextUsage(msg(), props.context.data.location.model.list(session()?.location), session()?.revert?.messageID),
  )
  // A nearly full window is about to compact, which is worth flagging as status feedback.
  const level = (percent: number) => {
    if (percent >= 90) return theme.text.feedback.error.base
    if (percent >= 75) return theme.text.feedback.warning.base
    return theme.text.base
  }

  return (
    <>
      <SidebarDod context={props.context} sessionID={props.sessionID} />
      <Show when={state() || cost() > 0}>
      <box>
        <box flexDirection="row" justifyContent="space-between">
          <text fg={theme.text.base}>
            <b>{t("Context")}</b>
          </text>
          <Show when={state()?.percent}>
            {(percent) => <text fg={level(percent())}>{t("{percent}% used", { percent: percent() })}</text>}
          </Show>
        </box>
        <Show when={state()?.percent}>
          {(percent) => {
            const filled = () => Math.max(0, Math.min(barWidth(), Math.round((percent() / 100) * barWidth())))
            return (
              <text wrapMode="none">
                <span style={{ fg: level(percent()) }}>{"█".repeat(filled())}</span>
                <span style={{ fg: theme.text.muted }}>{"░".repeat(barWidth() - filled())}</span>
              </text>
            )
          }}
        </Show>
        <box flexDirection="row" justifyContent="space-between" gap={1}>
          <Show when={state()}>
            {(value) => (
              <text fg={theme.text.muted} wrapMode="none">
                {Locale.number(value().tokens)}
                <Show when={value().limit}>{(limit) => ` / ${Locale.number(limit())}`}</Show> {t("tokens")}
              </text>
            )}
          </Show>
          <Show when={cost() > 0}>
            <text fg={theme.text.muted} wrapMode="none" flexShrink={0}>
              {t("{cost} spent", { cost: money.format(cost()) })}
            </text>
          </Show>
        </box>
      </box>
      </Show>
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
