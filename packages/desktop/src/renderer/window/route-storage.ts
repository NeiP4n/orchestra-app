export function getLastActiveUrl(windowID: string) {
  if (typeof localStorage !== "object") return "/"

  try {
    const key = windowLastActiveUrlKey(windowID)
    const legacyKey = `opencode.desktop.window.${windowID}.last-active-url`
    return acceptedLastActiveUrl(localStorage.getItem(key) ?? localStorage.getItem(legacyKey))
  } catch {
    return "/"
  }
}

export function setLastActiveUrl(windowID: string, value: string) {
  if (typeof localStorage !== "object") return

  try {
    localStorage.setItem(windowLastActiveUrlKey(windowID), value)
  } catch {}
}

export function acceptedLastActiveUrl(value: string | null | undefined) {
  if (value === "/") return value
  const path = value?.split(/[?#]/, 1)[0]

  if (path === "/settings") return value ?? "/"

  if (path === "/new-session") return value ?? "/"

  if (/^\/server\/[^/]+\/session\/[^/]+$/.test(path ?? "")) return value ?? "/"

  return "/"
}

function windowLastActiveUrlKey(windowID: string) {
  return `orchestra.desktop.window.${windowID}.last-active-url`
}
