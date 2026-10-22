import { useTerminalDimensions } from "@opentui/solid"
import { useOptionalConfig } from "../config"
import { useOptionalPanel } from "../context/panel"
import { useStorage } from "../context/storage"
import {
  clampSessionSidebarWidth,
  compactLayout,
  mobileLayout,
  SESSION_SIDEBAR_COMPACT_WIDTH,
  SESSION_SIDEBAR_WIDTH,
} from "./layout"

// Whether the panels use the compact or the mobile layout right now, and the session sidebar width that goes with it.
export function useCompactLayout() {
  const config = useOptionalConfig()
  const dimensions = useTerminalDimensions()
  const panels = useOptionalPanel()
  const [layout] = useStorage().store<{ sidebarWidth?: number }>("layout", { initial: {} })
  const mobile = () => mobileLayout(config?.data.layout)
  const compact = () => mobile() || compactLayout(config?.data.layout, dimensions().width)
  // On a phone the sidebar opens over the chat, so it takes the whole width beside the panel rail.
  const sidebarWidth = () =>
    mobile() ? panels?.width() || dimensions().width : clampSessionSidebarWidth(
      layout.sidebarWidth ??
        (compact() ? SESSION_SIDEBAR_COMPACT_WIDTH : SESSION_SIDEBAR_WIDTH),
      panels?.width() || dimensions().width,
    )
  return {
    compact,
    mobile,
    sidebarWidth,
  }
}
