import { createContinuationControl, type ContinuationAccess } from "@orchestra/client/solid"
import { Show } from "solid-js"
import { useClient } from "../context/client"
import { useTheme } from "../context/theme"
import { useT } from "../util/i18n"
import { HoverAction } from "./hover-action"

export function ContinuationSwitch(props: { access: ContinuationAccess; compact?: boolean }) {
  const control = createContinuationControl(props.access)
  const theme = useTheme()
  const tr = useT()
  return (
    <box flexDirection="column" flexShrink={0} paddingLeft={1}>
      <HoverAction
        id="continuation.toggle"
        disabled={control.busy() || control.enabled() === undefined}
        onClick={() => {
          void control.toggle()
        }}
      >
        <text fg={control.enabled() === false ? theme.text.action.primary.base : theme.text.base}>
          {control.busy()
            ? `◌ ${tr("Pausing / resuming…")}`
            : control.enabled() === undefined
              ? tr("All projects: no data")
              : control.enabled()
                ? props.compact
                  ? "∀▶"
                  : `▶ ${tr("All projects: ON")}`
                : props.compact
                  ? "∀Ⅱ"
                  : `Ⅱ ${tr("All projects: PAUSED")}`}
        </text>
      </HoverAction>
      <Show when={control.failed()}>
        <HoverAction
          id="continuation.retry"
          onClick={() => {
            void control.refresh()
          }}
        >
          <text fg={theme.text.action.primary.base}>{tr("Could not update. Retry")}</text>
        </HoverAction>
      </Show>
    </box>
  )
}

export function ContinuationSwitchConnected(props: { compact?: boolean }) {
  const client = useClient()
  return (
    <ContinuationSwitch
      compact={props.compact}
      access={{
        get: () => client.api.config.continuation.get(),
        set: (value) => client.api.config.continuation.set(value),
        onState: (receive) => client.event.on("config.continuation.updated", (event) => receive(event.data)),
        onReconnect: (refresh) => client.event.on("server.connected", refresh),
      }}
    />
  )
}
