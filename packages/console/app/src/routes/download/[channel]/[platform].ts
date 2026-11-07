import type { APIEvent } from "@solidjs/start"
import type { DownloadPlatform } from "../types"

// Orchestra desktop releases are published on GitHub. There are no separate
// stable/beta release trains (yet): both channels resolve to the same repo.
const assetNames: Record<string, string> = {
  "darwin-aarch64-dmg": "orchestra-desktop-mac-arm64.dmg",
  "darwin-x64-dmg": "orchestra-desktop-mac-x64.dmg",
  "windows-x64-nsis": "orchestra-desktop-win-x64.exe",
  "linux-x64-deb": "orchestra-desktop-linux-amd64.deb",
  "linux-x64-appimage": "orchestra-desktop-linux-x86_64.AppImage",
  "linux-x64-rpm": "orchestra-desktop-linux-x86_64.rpm",
} satisfies Record<DownloadPlatform, string>

// Doing this on the server lets us preserve the original name for platforms we don't care to rename for
const downloadNames: Record<string, string> = {
  "darwin-aarch64-dmg": "Orchestra Desktop.dmg",
  "darwin-x64-dmg": "Orchestra Desktop.dmg",
  "windows-x64-nsis": "Orchestra Desktop Installer.exe",
} satisfies { [K in DownloadPlatform]?: string }

export async function GET({ params: { platform } }: APIEvent) {
  const assetName = assetNames[platform]
  if (!assetName) return new Response(null, { status: 404 })

  const resp = await fetch(
    `https://github.com/NeiP4n/orchestra-app/releases/latest/download/${assetName}`,
  )

  const downloadName = downloadNames[platform]

  const headers = new Headers(resp.headers)
  if (downloadName) headers.set("content-disposition", `attachment; filename="${downloadName}"`)

  return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers })
}
