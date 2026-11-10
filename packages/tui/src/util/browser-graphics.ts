import { resolveImageRenderProtocol, type ImageRenderProtocol, type TerminalCapabilities } from "@opentui/core"

/** Explicit operator overrides win; otherwise use the renderer's positive graphics negotiation on every OS. */
export function browserGraphicsPreference(env: Record<string, string | undefined>): ImageRenderProtocol {
  const named = (env.ORCHESTRA_BROWSER_GFX ?? "").trim().toLowerCase()
  if (named === "sixel" || named === "kitty" || named === "blocks" || named === "auto") return named
  if (env.ORCHESTRA_BROWSER_HALFBLOCKS === "1") return "blocks"
  return "auto"
}
export function browserGraphicsProtocol(
  requested: ImageRenderProtocol,
  capabilities: TerminalCapabilities | null,
  resolution: { width: number; height: number } | null,
) {
  // Never infer graphics support from the OS, terminal name or WT_SESSION alone.
  return resolveImageRenderProtocol(
    requested,
    capabilities,
    !!resolution && resolution.width > 0 && resolution.height > 0,
  )
}
export const browserFrameGap = (protocol: ImageRenderProtocol) => (protocol === "blocks" ? 120 : 300)
