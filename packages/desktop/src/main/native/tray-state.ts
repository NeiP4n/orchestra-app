import { Predicate } from "effect"
import type { TrayUpdateStatus } from "../../shared/ipc-contract"
import { DESKTOP_CLOSE_TO_TRAY } from "../storage/keys"
import { getStore } from "../storage/store"

let closeToTrayEnabled = false

let currentStatus: TrayUpdateStatus = { status: "online" }

const listeners = new Set<() => void>()

export function isCloseToTrayEnabled(): boolean {
  try {
    const stored = getStore().get(DESKTOP_CLOSE_TO_TRAY)

    if (Predicate.isBoolean(stored)) {
      closeToTrayEnabled = stored

      return stored
    }
  } catch {
    // Store is not initialized or running in unit tests
  }

  return closeToTrayEnabled
}

export function setCloseToTray(enabled: boolean): void {
  closeToTrayEnabled = enabled

  try {
    getStore().set(DESKTOP_CLOSE_TO_TRAY, enabled)
  } catch {
    // Store is not initialized or running in unit tests
  }

  notifyTrayChanged()
}

export function getTrayStatus(): TrayUpdateStatus {
  return currentStatus
}

export function setTrayStatus(status: TrayUpdateStatus): void {
  currentStatus = status
  notifyTrayChanged()
}

export function onTrayChanged(listener: () => void): () => void {
  listeners.add(listener)

  return () => {
    listeners.delete(listener)
  }
}

function notifyTrayChanged(): void {
  listeners.forEach((listener) => listener())
}
