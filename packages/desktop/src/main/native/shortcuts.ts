import { app, globalShortcut } from "electron"
import { Predicate } from "effect"
import { DESKTOP_SHORTCUT_QUICK_ACTION } from "../storage/keys"
import { getStore } from "../storage/store"
import { toggleOrFocusMainWindow } from "../windows"

let registeredShortcut: string | null = null

export function getQuickActionShortcut(): string | null {
  if (registeredShortcut) return registeredShortcut

  try {
    const stored = getStore().get(DESKTOP_SHORTCUT_QUICK_ACTION)

    if (Predicate.isString(stored) && stored.length > 0) {
      return stored
    }
  } catch {
    // Store is not initialized or running in unit tests
  }

  return null
}

export function registerQuickActionShortcut(shortcut: string): boolean {
  if (!shortcut || !shortcut.trim()) {
    unregisterQuickActionShortcut()

    return true
  }

  const normalized = shortcut.trim()

  if (registeredShortcut && registeredShortcut !== normalized) {
    try {
      globalShortcut.unregister(registeredShortcut)
    } catch {
      // Ignore unregister errors
    }
  }

  let success = false

  try {
    success = globalShortcut.register(normalized, () => {
      toggleOrFocusMainWindow()
    })
  } catch {
    success = false
  }

  if (success) {
    registeredShortcut = normalized

    try {
      getStore().set(DESKTOP_SHORTCUT_QUICK_ACTION, normalized)
    } catch {
      // Store is not initialized or running in unit tests
    }

    return true
  }

  return false
}

export function unregisterQuickActionShortcut(): void {
  if (registeredShortcut) {
    try {
      globalShortcut.unregister(registeredShortcut)
    } catch {
      // Ignore unregister errors
    }

    registeredShortcut = null
  }

  try {
    getStore().delete(DESKTOP_SHORTCUT_QUICK_ACTION)
  } catch {
    // Store is not initialized or running in unit tests
  }
}

export function initShortcuts(): void {
  const saved = getQuickActionShortcut()

  if (saved) {
    registerQuickActionShortcut(saved)
  }

  try {
    app.once("will-quit", () => {
      destroyShortcuts()
    })
  } catch {
    // App lifecycle events may not be available in non-Electron runtimes
  }
}

export function destroyShortcuts(): void {
  try {
    globalShortcut.unregisterAll()
  } catch {
    // Ignore unregister errors
  }

  registeredShortcut = null
}
