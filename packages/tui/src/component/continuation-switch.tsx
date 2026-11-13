import { createContinuationControl, type ContinuationAccess } from "@orchestra/client/solid"
import { Show } from "solid-js"
import { useClient } from "../context/client"
import { useTheme } from "../context/theme"
import { useT } from "../util/i18n"
import { Keymap } from "../context/keymap"
import { useDialog } from "../ui/dialog"
import { HoverAction } from "./hover-action"

export function ContinuationSwitch(props: { access: ContinuationAccess; compact?: boolean; global?: boolean; visible?: boolean }) {
  const control = createContinuationControl(props.access)
  const theme = useTheme()
  const tr = useT()
  if (props.global) {
    const dialog = useDialog()
    Keymap.createLayer(() => ({
      mode: "global",
      commands: [{
        id: "continuation.toggle",
        title: control.enabled() === false ? "Resume all projects" : "Pause all projects",
        group: "System",
        bind: false,
        palette: true,
        enabled: !control.busy() && control.enabled() !== undefined,
        run: () => { dialog.clear(); void control.toggle() },
      }],
    }))
  }
  return (
    <Show when={props.visible !== false}>
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
    </Show>
  )
}

export function ContinuationSwitchConnected(props: { compact?: boolean; global?: boolean; visible?: boolean }) {
  const client = useClient()
  return (
    <ContinuationSwitch
      compact={props.compact}
      global={props.global}
      visible={props.visible}
      access={{
        get: () => client.api.config.continuation.get(),
        set: (value) => client.api.config.continuation.set(value),
        onState: (receive) => client.event.on("config.continuation.updated", (event) => receive(event.data)),
        onReconnect: (refresh) => client.event.on("server.connected", refresh),
      }}
    />
  )
}
