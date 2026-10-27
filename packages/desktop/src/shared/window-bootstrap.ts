// What the main process already knows when it creates a window, handed to the renderer through the
// preload's argv so the shell can mount before the IPC port exists. Undefined means "ask over IPC".
export type WindowBootstrap = {
  id: string
  firstLaunchPending?: boolean
  /** The app runs packaged (`app.isPackaged`), as extensions' `Build.packaged` reports in both processes. */
  packaged?: boolean
}

const prefix = "--orchestra-window="
const legacyPrefix = "--opencode-window="

export function windowBootstrapArgument(bootstrap: WindowBootstrap) {
  return prefix + encodeURIComponent(JSON.stringify(bootstrap))
}

export function windowBootstrapFromArguments(args: readonly string[]): WindowBootstrap {
  const arg = args.find((item) => item.startsWith(prefix) || item.startsWith(legacyPrefix))
  const value = arg?.startsWith(prefix) ? arg.slice(prefix.length) : arg?.slice(legacyPrefix.length)

  if (!value) throw new Error("Window bootstrap argument not found")

  return JSON.parse(decodeURIComponent(value))
}
