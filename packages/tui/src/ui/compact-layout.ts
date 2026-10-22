import { useTerminalDimensions } from "@opentui/solid"
import { useOptionalConfig } from "../config"
import { useOptionalPanel } from "../context/panel"
import { useStorage } from "../context/storage"
import {
  adaptivePanelWidth,
  clampSessionSidebarWidth,
  compactLayout,
  density,
  mobileLayout,
  panelWidthFromShare,
  SESSION_SIDEBAR_COMPACT_WIDTH,
  SESSION_SIDEBAR_WIDTH,
} from "./layout"

// Whether the panels use the compact or the mobile layout right now, and the session sidebar width that goes with it.
export function useCompactLayout() {
  const config = useOptionalConfig()
  const dimensions = useTerminalDimensions()
  const panels = useOptionalPanel()
  const [layout] = useStorage().store<{ sidebarShare?: number }>("layout", { initial: {} })
  const mobile = () => mobileLayout(config?.data.layout)
  const compact = () => mobile() || compactLayout(config?.data.layout, dimensions().width)
  const room = () => panels?.width() || dimensions().width
  // On a phone the sidebar opens over the chat, so it takes the whole width beside the panel rail.
  // Elsewhere it grows with the terminal unless the user dragged it to a share of their own.
  const sidebarWidth = () =>
    mobile()
      ? room()
      : clampSessionSidebarWidth(
          panelWidthFromShare(layout.sidebarShare, room()) ??
            (compact() ? SESSION_SIDEBAR_COMPACT_WIDTH : adaptivePanelWidth(dimensions().width, SESSION_SIDEBAR_WIDTH)),
          room(),
        )
  return {
    compact,
    mobile,
    sidebarWidth,
    // How much room the terminal gives right now; every part trims its decoration from the same reading.
    density: () => density(dimensions().width, dimensions().height),
  }
}
