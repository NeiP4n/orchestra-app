import type { ElectronAPI } from "../api-types"

const deepLinkEvent = "orchestra:deep-link"

export function startDeepLinks(api: ElectronAPI) {
  void api.consumeInitialDeepLinks().then(emitDeepLinks)
  api.onDeepLink(emitDeepLinks)
}

function emitDeepLinks(urls: string[]) {
  if (urls.length === 0) return
  window.__ORCHESTRA__ ??= {}
  window.__ORCHESTRA__.deepLinks = [...(window.__ORCHESTRA__.deepLinks ?? []), ...urls]
  window.dispatchEvent(new CustomEvent(deepLinkEvent, { detail: { urls } }))
  window.dispatchEvent(new CustomEvent("opencode:deep-link", { detail: { urls } }))
}
