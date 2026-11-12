import { createLinuxClipboardFallback, LINUX_PASTE_HINT } from "./clipboard-linux"
import {
  createClipboard,
  createHostClipboard,
  createRendererClipboardAdapter,
  decodePasteBytes,
  type ClipboardService as CoreClipboardService,
  type RendererClipboardBoundary,
} from "@opentui/core"
import type { ClipboardContent, ClipboardService } from "./context/clipboard"

export type OwnedClipboardService = Required<ClipboardService> & Readonly<{ dispose(): Promise<void> }>

export function createTuiClipboard(renderer: RendererClipboardBoundary): OwnedClipboardService {
  const terminal = createRendererClipboardAdapter(renderer)
  const remote = terminal.remote || Boolean(process.env.SSH_CONNECTION || process.env.SSH_TTY || process.env.SSH_CLIENT)
  return createClipboardAdapter(
    createClipboard({ host: createHostClipboard(), terminal: { ...terminal, remote } }),
    process.platform === "linux" ? { fallbackRead: remote ? async () => { throw new Error(LINUX_PASTE_HINT) } : createLinuxClipboardFallback() } : undefined,
  )
}

export function createClipboardAdapter(clipboard: CoreClipboardService, options?: { fallbackRead?: () => Promise<ClipboardContent | undefined> }): OwnedClipboardService {
  return {
    async read(): Promise<ClipboardContent | undefined> {
      let result
      try {
        result = await clipboard.read({ preferredTypes: ["image/png", "text/plain"], selection: "clipboard" })
      } catch (error) {
        if (options?.fallbackRead) return options.fallbackRead()
        throw error
      }
      if (result.status !== "read") {
        if (options?.fallbackRead && ["empty", "unsupported", "failed", "timed-out"].includes(result.status)) return options.fallbackRead()
        if (result.status === "failed") throw result.error
        if (result.status === "timed-out") throw new Error("Clipboard read timed out")
        if (result.status === "limit-exceeded") {
          throw new RangeError("Clipboard content exceeded configured read or image conversion limits")
        }
        return undefined
      }

      if (result.representation.mimeType === "image/png") {
        return {
          data: Buffer.from(result.representation.bytes).toString("base64"),
          mime: result.representation.mimeType,
        }
      }
      if (result.representation.mimeType === "text/plain") {
        if (result.representation.bytes.length === 0) return undefined
        return {
          data: decodePasteBytes(result.representation.bytes),
          mime: result.representation.mimeType,
        }
      }
      throw new Error(`Unexpected clipboard MIME type: ${result.representation.mimeType}`)
    },
    async write(text) {
      // OpenTUI rejects NUL before any destination; host clipboard text cannot contain it.
      const result = await clipboard.writeText(text.replaceAll("\0", ""), {
        destination: "all-available",
        selection: "clipboard",
      })
      if (result.host.status === "written" || result.terminal.status === "attempted") return
      if (result.host.status === "failed") throw result.host.error
      throw new Error(`Clipboard write failed (host: ${result.host.status}, terminal: ${result.terminal.status})`)
    },
    dispose() {
      return clipboard.dispose()
    },
  }
}
