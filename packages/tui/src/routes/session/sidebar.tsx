import { useData } from "../../context/data"
import { createMemo, Show } from "solid-js"
import { useTheme } from "../../context/theme"
import { useConfig } from "../../config"
import { HoverAction } from "../../component/hover-action"
import { Slot } from "../../plugin/render"
import { withTimestampedFallback } from "@orchestra/util/session-title-fallback"
import { TextAttributes } from "@opentui/core"
import "../../component/title-shimmer"

import { getScrollAcceleration } from "../../util/scroll"
import { useCompactLayout } from "../../ui/compact-layout"
import { NeuralLine, NeuronDot } from "../../component/neural"
import { SessionNetwork, SessionNetworkField, useEmptyRoom } from "../../component/session-network"

export function Sidebar(props: { sessionID: string; onHide?: () => void; width?: number; borderLeft?: boolean }) {
  const data = useData()
  const theme = useTheme()
  const config = useConfig().data
  const session = createMemo(() => data.session.get(props.sessionID))
  const scrollAcceleration = createMemo(() => getScrollAcceleration(config))
  const layout = useCompactLayout()
  const width = () => props.width ?? layout.sidebarWidth()
  const running = () => data.session.status(props.sessionID) === "running"
  // The Session's network fills whatever the sidebar's content leaves empty below it.
  const empty = useEmptyRoom()

  return (
    <Show when={session()}>
      <box
        backgroundColor={theme.background.raised.base}
        width={width()}
        height="100%"
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={layout.compact() ? 1 : 2}
        paddingRight={layout.compact() ? 1 : 2}
        position="relative"
        border={props.borderLeft ? ["left"] : undefined}
        borderColor={theme.border.base}
      >
        <box flexDirection="row" alignItems="center" flexShrink={0} paddingRight={1} gap={1}>
          {/* The session's own neuron: it beats faster while the agent works. */}
          <NeuronDot energy={running() ? 0.35 : 0.04} session={props.sessionID} />
          <box flexGrow={1} minWidth={0}>
            <title_shimmer
              fg={theme.text.base}
              rename={{
                pending: data.session.title.pending(props.sessionID),
                title: withTimestampedFallback(session()),
              }}
              enabled={config.animations ?? true}
              backdrop={theme.background.raised.base}
              attributes={
                data.session.title.pending(props.sessionID) && config.animations === false
                  ? TextAttributes.DIM
                  : TextAttributes.BOLD
              }
            >
              {withTimestampedFallback(session())}
            </title_shimmer>
          </box>
          <Show when={props.onHide}>
            <HoverAction id="session.sidebar.hide" onClick={() => props.onHide?.()} paddingLeft={1} paddingRight={1}>
              <text fg={theme.text.action.primary.base}>›</text>
            </HoverAction>
          </Show>
        </box>
        <box flexShrink={0} paddingTop={1} paddingBottom={1}>
          <NeuralLine
            energy={running() ? 0.35 : 0.04}
            seed={4}
            session={props.sessionID}
            backdrop={theme.background.raised.base}
          />
        </box>
        <box flexShrink={0} paddingRight={1} paddingBottom={1}>
          <SessionNetwork sessionID={props.sessionID} />
        </box>
        <box
          flexGrow={1}
          minHeight={0}
          position="relative"
          onSizeChange={function () {
            empty.area(this.height)
          }}
        >
          <scrollbox
            flexGrow={1}
            minHeight={0}
            scrollAcceleration={scrollAcceleration()}
            // The sidebar only scrolls vertically; a horizontal bar steals a row during initial layout.
            horizontalScrollbarOptions={{ visible: false }}
            verticalScrollbarOptions={{
              // Use the content's reserved right padding instead of changing its width when the bar toggles.
              position: "absolute",
              right: 0,
              top: 0,
              width: 1,
              height: "100%",
              trackOptions: {
                backgroundColor: theme.background.raised.base,
                foregroundColor: theme.scrollbar.base,
              },
            }}
          >
            <box
              flexShrink={0}
              gap={1}
              paddingRight={1}
              onSizeChange={function () {
                empty.content(this.height)
              }}
            >
              <Slot path="sidebar.content" input={{ sessionID: props.sessionID }} />
            </box>
          </scrollbox>
          <Show when={empty.room() >= 4}>
            <box position="absolute" left={0} bottom={0} width="100%" height={empty.room()} paddingRight={1}>
              <SessionNetworkField
                sessionID={props.sessionID}
                backdrop={theme.background.raised.base}
                height={empty.room()}
              />
            </box>
          </Show>
        </box>

        <box flexShrink={0} gap={1} paddingTop={1}>
          <Slot path="sidebar.footer" input={{ sessionID: props.sessionID }} />
        </box>
      </box>
    </Show>
  )
}
