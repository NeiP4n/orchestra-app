import type { Platform } from "@orchestra/app/desktop"
import type { ElectronAPI } from "../api-types"
import { setPinchZoomEnabled, webviewZoom } from "../window/zoom"
import { windowFullscreen } from "../window/fullscreen"
import { DragCancelEvent } from "../../shared/ipc-transport"
import { createExtensionBridge } from "../extensions"
import { createDesktopFiles } from "./files"
import { createDesktopMenuAction } from "./menu"
import { createDesktopNotify } from "./notifications"
import { createDesktopStorage } from "./storage"

export type DesktopWindowState = {
  id: string
  version: string
}

export function createDesktopPlatform(api: ElectronAPI, windowState: DesktopWindowState): Platform {
  const os = desktopOS()

  return {
    platform: "desktop",
    os,
    version: windowState.version,
    windowID: windowState.id,
    ...createDesktopFiles(api, os),
    ...createDesktopStorage(api),
    exportDebugLogs: () => api.exportDebugLogs(),
    setForceFocus: (enabled) => api.setForceFocus(enabled),
    recordFatalRendererError: (error) => api.recordFatalRendererError(error),
    restart: async () => api.relaunch(),
    notify: createDesktopNotify(api),
    fetch: (input, init) => {
      if (input instanceof Request) return fetch(input)

      return fetch(input, init)
    },
    webviewZoom,
    windowFullscreen,
    getPinchZoomEnabled: () => api.getPinchZoomEnabled(),
    setPinchZoomEnabled,
    onDragCancel: (callback) => {
      window.addEventListener(DragCancelEvent, callback)

      return () => window.removeEventListener(DragCancelEvent, callback)
    },
    runDesktopMenuAction: createDesktopMenuAction(api),
    machines: {
      start: async (id) => {
        const machine = await api.machinesStart(id)

        return {
          id: machine.id,
          name: machine.name,
          backend: machine.backend,
          cpu: machine.cpu,
          memoryMb: machine.memoryMb,
          diskGb: machine.diskGb,
          network: machine.network,
          status: machine.status,
          snapshotId: machine.snapshotId,
          projectId: machine.projectId,
          createdAt: machine.createdAt,
        }
      },
      stop: async (id) => {
        const machine = await api.machinesStop(id)

        return {
          id: machine.id,
          name: machine.name,
          backend: machine.backend,
          cpu: machine.cpu,
          memoryMb: machine.memoryMb,
          diskGb: machine.diskGb,
          network: machine.network,
          status: machine.status,
          snapshotId: machine.snapshotId,
          projectId: machine.projectId,
          createdAt: machine.createdAt,
        }
      },
      snapshot: async (id) => {
        const machine = await api.machinesSnapshot(id)

        return {
          id: machine.id,
          name: machine.name,
          backend: machine.backend,
          cpu: machine.cpu,
          memoryMb: machine.memoryMb,
          diskGb: machine.diskGb,
          network: machine.network,
          status: machine.status,
          snapshotId: machine.snapshotId,
          projectId: machine.projectId,
          createdAt: machine.createdAt,
        }
      },
    },
    checkAppExists: async (appName) => {
      return api.checkAppExists(appName)
    },
    extensions: createExtensionBridge(),
  }
}

function desktopOS() {
  if (navigator.userAgent.includes("Mac")) return "macos"

  if (navigator.userAgent.includes("Windows")) return "windows"

  if (navigator.userAgent.includes("Linux")) return "linux"

  return undefined
}
