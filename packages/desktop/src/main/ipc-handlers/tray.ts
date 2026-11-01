import { Effect } from "effect"
import { TrayRpcs } from "../../shared/ipc-rpc"
import { getTrayStatus, isCloseToTrayEnabled, setCloseToTray, setTrayStatus } from "../native/tray-state"

export const getCloseToTray = () => isCloseToTrayEnabled()

export { getTrayStatus, isCloseToTrayEnabled }

export const trayHandlers = TrayRpcs.toLayer(
  Effect.gen(function* () {
    return TrayRpcs.of({
      TrayUpdateStatus: ({ status, activeTasks }) =>
        Effect.sync(() => {
          setTrayStatus({ status, activeTasks })
        }),
      TraySetCloseToTray: ({ enabled }) =>
        Effect.sync(() => {
          setCloseToTray(enabled)
        }),
      TrayGetCloseToTray: () =>
        Effect.sync(() => ({
          enabled: isCloseToTrayEnabled(),
        })),
    })
  }),
)
