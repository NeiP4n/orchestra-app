import { RpcClient, RpcClientError } from "effect/unstable/rpc"
import { AppRpcs } from "./ipc-rpc/app"
import { EventRpcs } from "./ipc-rpc/events"
import { ExtensionRpcs } from "./ipc-rpc/extensions"
import { FileRpcs } from "./ipc-rpc/files"
import { MachineRpcs } from "./ipc-rpc/machines"
import { MenuRpcs } from "./ipc-rpc/menu"
import { ShortcutRpcs } from "./ipc-rpc/shortcuts"
import { StorageRpcs } from "./ipc-rpc/storage"
import { TrayRpcs } from "./ipc-rpc/tray"
import { WindowRpcs } from "./ipc-rpc/window"

export { AppRpcs } from "./ipc-rpc/app"

export { EventRpcs } from "./ipc-rpc/events"

export { ExtensionRpcs } from "./ipc-rpc/extensions"

export { FileRpcs } from "./ipc-rpc/files"

export { MachineRpcs } from "./ipc-rpc/machines"

export { MenuRpcs } from "./ipc-rpc/menu"

export { ShortcutRpcs, ShortcutsRegisterQuickAction } from "./ipc-rpc/shortcuts"

export { StorageRpcs } from "./ipc-rpc/storage"

export {
  TrayGetCloseToTray,
  TrayRpcs,
  TraySetCloseToTray,
  TrayStatusSchema,
  TrayUpdateStatus,
} from "./ipc-rpc/tray"

export type { TrayStatus } from "./ipc-rpc/tray"

export { WindowRpcs } from "./ipc-rpc/window"

export const DesktopRpcs = AppRpcs.merge(
  StorageRpcs,
  FileRpcs,
  WindowRpcs,
  MenuRpcs,
  EventRpcs,
  ExtensionRpcs,
  TrayRpcs,
  ShortcutRpcs,
  MachineRpcs,
)

export type DesktopRpcClient = RpcClient.FromGroup<typeof DesktopRpcs, RpcClientError.RpcClientError>
