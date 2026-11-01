import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { TraySetCloseToTray, TrayStatusSchema, TrayUpdateStatus } from "../../shared/ipc-rpc/tray"
import { ShortcutsRegisterQuickAction } from "../../shared/ipc-rpc/shortcuts"
import {
  getTrayStatus,
  isCloseToTrayEnabled,
  onTrayChanged,
  setCloseToTray,
  setTrayStatus,
} from "./tray-state"

describe("tray state", () => {
  test("maintains status, active tasks count, and notifies listeners", () => {
    let notified = 0

    const unsubscribe = onTrayChanged(() => {
      notified += 1
    })

    setTrayStatus({ status: "busy", activeTasks: 3 })
    expect(getTrayStatus()).toEqual({ status: "busy", activeTasks: 3 })
    expect(notified).toBe(1)

    setTrayStatus({ status: "offline" })
    expect(getTrayStatus()).toEqual({ status: "offline" })
    expect(notified).toBe(2)

    unsubscribe()
    setTrayStatus({ status: "online", activeTasks: 0 })
    expect(getTrayStatus()).toEqual({ status: "online", activeTasks: 0 })
    expect(notified).toBe(2)
  })

  test("toggles close-to-tray preference", () => {
    setCloseToTray(true)
    expect(isCloseToTrayEnabled()).toBe(true)

    setCloseToTray(false)
    expect(isCloseToTrayEnabled()).toBe(false)
  })

  test("validates tray and shortcut IPC RPC schemas", () => {
    const decodeStatus = Schema.decodeUnknownSync(TrayStatusSchema)
    expect(decodeStatus("online")).toBe("online")
    expect(decodeStatus("busy")).toBe("busy")
    expect(decodeStatus("offline")).toBe("offline")
    expect(() => decodeStatus("invalid")).toThrow()

    const decodeUpdate = Schema.decodeUnknownSync(TrayUpdateStatus.payloadSchema)
    expect(decodeUpdate({ status: "online", activeTasks: 2 })).toEqual({ status: "online", activeTasks: 2 })
    expect(decodeUpdate({ status: "busy" })).toEqual({ status: "busy" })
    expect(() => decodeUpdate({ status: "other" })).toThrow()

    const decodeCloseToTray = Schema.decodeUnknownSync(TraySetCloseToTray.payloadSchema)
    expect(decodeCloseToTray({ enabled: true })).toEqual({ enabled: true })
    expect(() => decodeCloseToTray({ enabled: "yes" })).toThrow()

    const decodeShortcut = Schema.decodeUnknownSync(ShortcutsRegisterQuickAction.payloadSchema)
    expect(decodeShortcut({ shortcut: "CommandOrControl+Shift+Space" })).toEqual({
      shortcut: "CommandOrControl+Shift+Space",
    })
    expect(() => decodeShortcut({ shortcut: 123 })).toThrow()
  })
})
