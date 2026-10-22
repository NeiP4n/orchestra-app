/**
 * How the WARP installer is invoked and how its exit codes are read. winget forwards the inner
 * installer's code, so a bare "255" reaches us with no reason attached: the arguments therefore
 * leave the package manager nothing to ask interactively, and the caller always pairs the code
 * with the package manager's own output and with the CLI that is really on disk.
 */

/**
 * WARP installs machine-wide, which is what the manifest declares. Naming the scope, the source,
 * and silence leaves no prompt for a child that is started without a terminal to answer on.
 */
export function warpWingetArgs() {
  return [
    "install",
    "--id",
    "Cloudflare.Warp",
    "-e",
    "--source",
    "winget",
    "--scope",
    "machine",
    "--silent",
    "--accept-source-agreements",
    "--accept-package-agreements",
  ]
}

// winget answers 43 / 0x8A15002B / 0x8A150061 when the package is already installed or no newer
// version exists, and 3010 is the Windows convention for "installed, a reboot is pending".
const noopWingetCodes = new Set([43, 0x8a15002b, 0x8a150061])

export function installerExitSucceeded(command: string, code: number | null | undefined) {
  if (code === 0 || code === 3010) return true
  if (command !== "winget" || code === undefined || code === null) return false
  return noopWingetCodes.has(code)
}

/** The package manager's own words for the failure, flattened and trimmed to a dialog's worth. */
export function installerFailureDetail(output: string, limit = 600) {
  const clean = output.replace(/\s+/g, " ").trim()
  if (!clean) return ""
  return clean.length <= limit ? clean : "…" + clean.slice(-limit)
}
