import { existsSync } from "node:fs"
import path from "node:path"
import { app, Menu, nativeImage, Tray } from "electron"
import type { MenuItemConstructorOptions, NativeImage } from "electron"
import {
  getTrayStatus,
  isCloseToTrayEnabled,
  onTrayChanged,
  setCloseToTray,
  setTrayStatus,
} from "./tray-state"
import { nativeLocale, nativeT, onNativeTranslations } from "./translations"
import { setAppQuitting, showAndFocusMainWindow, toggleOrFocusMainWindow } from "../windows"

let tray: Tray | null = null

let removeListener: (() => void) | null = null

let removeTranslationsListener: (() => void) | null = null

function resolveTrayIcon(): NativeImage {
  const isWin = process.platform === "win32"

  const candidateFilenames = isWin
    ? ["icon.ico", "icon.png"]
    : ["icon.png", "icon.ico"]

  const baseDirs: string[] = []

  if (app.isPackaged) {
    baseDirs.push(path.join(process.resourcesPath, "icons"))
    baseDirs.push(process.resourcesPath)
  } else {
    try {
      const appPath = app.getAppPath()
      baseDirs.push(path.join(appPath, "resources", "icons"))
      baseDirs.push(path.join(appPath, "icons", "dev"))
      baseDirs.push(path.join(appPath, "icons", "prod"))
    } catch {
      // App path may not be available in test runtimes
    }
  }

  for (const dir of baseDirs) {
    for (const filename of candidateFilenames) {
      const candidatePath = path.join(dir, filename)

      if (existsSync(candidatePath)) {
        try {
          const img = nativeImage.createFromPath(candidatePath)

          if (!img.isEmpty()) {
            return img
          }
        } catch {
          // Try next candidate
        }
      }
    }
  }

  const fallbackBuffer = Buffer.alloc(16 * 16 * 4, 128)

  return nativeImage.createFromBuffer(fallbackBuffer, { width: 16, height: 16 })
}

function buildContextMenu(): Menu {
  const currentStatus = getTrayStatus()
  const isRussian = nativeLocale().startsWith("ru")

  const statusSubmenu: MenuItemConstructorOptions[] = [
    {
      label: isRussian ? "Онлайн" : "Online",
      type: "radio",
      checked: currentStatus.status === "online",
      click: () => setTrayStatus({ ...currentStatus, status: "online" }),
    },
    {
      label: isRussian ? "Занят" : "Busy",
      type: "radio",
      checked: currentStatus.status === "busy",
      click: () => setTrayStatus({ ...currentStatus, status: "busy" }),
    },
    {
      label: isRussian ? "Офлайн" : "Offline",
      type: "radio",
      checked: currentStatus.status === "offline",
      click: () => setTrayStatus({ ...currentStatus, status: "offline" }),
    },
  ]

  if (currentStatus.activeTasks !== undefined) {
    statusSubmenu.push({ type: "separator" })
    statusSubmenu.push({
      label: isRussian ? `Активных задач: ${currentStatus.activeTasks}` : `Active tasks: ${currentStatus.activeTasks}`,
      enabled: false,
    })
  }

  const template: MenuItemConstructorOptions[] = [
    {
      label: isRussian ? "Показать Orchestra" : "Show Orchestra",
      click: () => {
        showAndFocusMainWindow()
      },
    },
    {
      label: isRussian ? "Статус" : "Status",
      submenu: statusSubmenu,
    },
    {
      label: isRussian ? "Закрывать в трей" : "Close to Tray",
      type: "checkbox",
      checked: isCloseToTrayEnabled(),
      click: (item) => {
        setCloseToTray(item.checked)
      },
    },
    {
      type: "separator",
    },
    {
      label: nativeT("desktop.recovery.action.quit"),
      click: () => {
        setAppQuitting(true)
        app.quit()
      },
    },
  ]

  return Menu.buildFromTemplate(template)
}

export function updateTray(): void {
  if (!tray || tray.isDestroyed()) return

  const currentStatus = getTrayStatus()
  const isRussian = nativeLocale().startsWith("ru")

  const statusMapRu = {
    online: "Онлайн",
    busy: "Занят",
    offline: "Офлайн",
  } as const

  const statusMapEn = {
    online: "Online",
    busy: "Busy",
    offline: "Offline",
  } as const

  const statusText = isRussian
    ? statusMapRu[currentStatus.status] ?? "Онлайн"
    : statusMapEn[currentStatus.status] ?? "Online"

  const taskPrefix = isRussian ? "Задач" : "Tasks"
  const tasksText = currentStatus.activeTasks !== undefined ? ` (${taskPrefix}: ${currentStatus.activeTasks})` : ""

  try {
    tray.setToolTip(`Orchestra - ${statusText}${tasksText}`)
    tray.setContextMenu(buildContextMenu())
  } catch {
    // Ignore error if tray was destroyed concurrently
  }
}

export function initTray(): Tray | null {
  if (tray && !tray.isDestroyed()) return tray

  try {
    const icon = resolveTrayIcon()
    tray = new Tray(icon)
  } catch {
    return null
  }

  tray.on("click", () => {
    toggleOrFocusMainWindow()
  })

  tray.on("double-click", () => {
    showAndFocusMainWindow()
  })

  removeListener = onTrayChanged(() => {
    updateTray()
  })

  removeTranslationsListener = onNativeTranslations(() => {
    updateTray()
  })

  updateTray()

  try {
    app.once("will-quit", () => {
      destroyTray()
    })
  } catch {
    // App lifecycle events may not be available in non-Electron runtimes
  }

  return tray
}

export function destroyTray(): void {
  if (removeListener) {
    removeListener()
    removeListener = null
  }

  if (removeTranslationsListener) {
    removeTranslationsListener()
    removeTranslationsListener = null
  }

  if (tray) {
    try {
      if (!tray.isDestroyed()) {
        tray.destroy()
      }
    } catch {
      // Ignore destroy error
    }

    tray = null
  }
}

export function getTray(): Tray | null {
  return tray && !tray.isDestroyed() ? tray : null
}
