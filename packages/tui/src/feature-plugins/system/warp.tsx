import { tr } from "../../util/i18n"
import { execFile, spawn } from "node:child_process"
import { access, readFile } from "node:fs/promises"
import * as Warp from "@orchestra/core/warp"
import { Plugin } from "@orchestra/plugin/tui"
import { createSignal } from "solid-js"
import { hoverBackground } from "../../ui/hover"
import { installerExitSucceeded, installerFailureDetail, warpWingetArgs } from "./warp-install"
import { isAddressCapFailure, isAutoRotationFailure, isRateLimitFailure, warpStatusError, type WarpConnectionState, type WarpStatus } from "./warp-status"
import { createRateLimitContinuations } from "./warp-continuation"
import { createRotationGate, describeAutoRotation, type AutoRotationState } from "./warp-rotation"
import { modelKey, pickFallbackModel } from "./warp-fallback"
import { isRateLimitedTurnPending, RATE_LIMIT_CONTINUATION_PROMPT } from "../../util/session"

type WarpAction = "refresh" | "connect" | "disconnect" | "reconnect" | "reset" | "install" | "proxy" | "disableProxy" | "changeIp"
type SharedBusy = { action: WarpAction | null }

const STATUS_REFRESH_MS = 30_000
// The sidebar's label column, so the values of the WARP block line up.
const LABEL_WIDTH = 12
// The exit IP only changes on a rotation or a reconnect, so probing Cloudflare's trace endpoint
// on every status tick was constant outbound traffic for information nothing displays in between.
const EXIT_IP_REFRESH_MS = 10 * 60_000

function language(context: Plugin.Context) {
  return context.ui.language() === "ru" ? "ru" : "en"
}

function text(context: Plugin.Context, en: string, ru: string) {
  return language(context) === "ru" ? ru : en
}

function statusLabel(context: Plugin.Context, state: WarpConnectionState) {
  const ru = language(context) === "ru"
  switch (state) {
    case "checking":
      return ru ? tr("Checking…") : "Checking…"
    case "connected":
      return ru ? tr("Connected") : "Connected"
    case "disconnected":
      return ru ? tr("Disconnected") : "Disconnected"
    case "unavailable":
      return ru ? tr("WARP CLI not found") : "WARP CLI not found"
    default:
      return ru ? tr("Status unknown") : "Status unknown"
  }
}

function statusColor(context: Plugin.Context, state: WarpConnectionState) {
  const theme = context.theme
  if (state === "connected") return theme.text.feedback.success.base
  if (state === "disconnected") return theme.text.feedback.warning.base
  if (state === "unavailable" || state === "unknown") return theme.text.feedback.error.base
  return theme.text.muted
}

function messageOf(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause)
}

const readWarpStatus = Warp.status

function describe(context: Plugin.Context, cause: unknown) {
  if (cause instanceof Warp.WarpError) {
    switch (cause.code) {
      case "cli-missing":
        return text(context, "Cloudflare WARP CLI was not found. Install WARP first.", tr("Cloudflare WARP CLI not found. Install WARP first."))
      case "daemon-down":
        return text(context, "The WARP background service is not running. Press \"Route only OpenCode through WARP\" to start it (Windows may ask for confirmation).", tr("The WARP background service is not running. Press “Only OpenCode through WARP…” to start it (Windows may ask to confirm)."))
      case "not-proxy-mode":
        return text(context, "WARP is not in Local Proxy mode, so it would affect the whole device. Use \"Route only OpenCode through WARP\" first.", tr("WARP is not in Local Proxy mode and would affect the whole device. Press “Only OpenCode through WARP” first."))
      case "device-in-use":
        return text(context, "WARP is connected for the whole device. OpenCode will not switch it to Local Proxy because other applications would lose their tunnel. Disconnect WARP and retry.", tr("WARP is connected for every app. OpenCode will not switch it to Local Proxy, or the other apps would lose the tunnel. Disconnect WARP and try again."))
      case "socks-only":
        return text(context, "This WARP version's local proxy speaks SOCKS5 only; OpenCode needs HTTP. Update Cloudflare WARP.", tr("This WARP version's local proxy speaks only SOCKS5, and OpenCode needs HTTP. Update Cloudflare WARP."))
      case "managed-registration":
        return text(context, "This WARP client is managed by an organization (Zero Trust); its registration cannot be reset here.", tr("This WARP is managed by an organization (Zero Trust); its registration cannot be reset from here."))
      case "no-traffic":
        return text(
          context,
          cause.message,
          "Через WARP не идёт трафик даже через релей OpenCode (он пробовал локальные SOCKS5-порты VPN: 10808, 7897, 7890, 2080, 12334… и прямое соединение), поэтому IP не меняется. Включите в своём VPN (Clash Verge, Happ, v2rayN…) SOCKS5-порт с UDP или укажите его: ORCHESTRA_WARP_UPSTREAM=socks5://127.0.0.1:<порт>.",
        )
      default:
        return cause.message
    }
  }
  return messageOf(cause)
}

async function performWarpAction(action: WarpAction, context: Plugin.Context): Promise<WarpStatus> {
  if (action === "refresh") return readWarpStatus()
  if (action === "connect") return Warp.connect()
  if (action === "disconnect") return Warp.disconnect()
  if (action === "reconnect") return Warp.reconnect()
  return Warp.resetRegistration()
}

function setSharedStatus(set: (mutation: (draft: WarpStatus) => void) => void, value: WarpStatus) {
  set((draft) => {
    draft.state = value.state
    draft.details = value.details
  })
}

function setSharedBusy(set: (mutation: (draft: SharedBusy) => void) => void, action: WarpAction | null) {
  set((draft) => {
    draft.action = action
  })
}

function commandExists(command: string): Promise<boolean> {
  const checker = process.platform === "win32" ? "where.exe" : "which"
  return new Promise((resolve) => {
    execFile(checker, [command], { timeout: 5_000, windowsHide: true }, (error) => resolve(!error))
  })
}

function runInteractive(context: Plugin.Context, command: string, args: string[]): Promise<void> {
  const needsTerminal = command !== "winget" && command !== "brew"
  if (needsTerminal) context.renderer.suspend()
  return new Promise<void>((resolve, reject) => {
    let settled = false
    // winget runs with no terminal to print to, so its output is the only place the reason behind
    // an exit code exists; collect it here to carry into the failure the caller reports.
    let output = ""
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      if (needsTerminal) context.renderer.resume()
      if (error) reject(error)
      else resolve()
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(command, args, { stdio: needsTerminal ? "inherit" : ["ignore", "pipe", "pipe"], windowsHide: !needsTerminal })
    } catch (cause) {
      finish(cause instanceof Error ? cause : new Error(String(cause)))
      return
    }
    if (!needsTerminal) {
      const collect = (chunk: Buffer | string) => { output = (output + String(chunk)).slice(-8_192) }
      child.stdout?.setEncoding("utf8")
      child.stderr?.setEncoding("utf8")
      child.stdout?.on("data", collect)
      child.stderr?.on("data", collect)
    }
    child.once("error", (cause) => finish(cause instanceof Error ? cause : new Error(String(cause))))
    child.once("close", (code) => {
      if (installerExitSucceeded(command, code)) finish()
      else {
        const detail = installerFailureDetail(output)
        const message = "Installer exited with code " + String(code ?? "unknown") + "."
        finish(new Error(detail ? message + " " + detail : message))
      }
    })
  })
}

// The same install again with administrator rights: a machine-scope package fails in a process
// that cannot elevate on its own, and Windows shows its usual consent prompt for this child.
function runElevatedInstaller(command: string, args: string[]): Promise<number | undefined> {
  const list = args.map((arg) => `'${arg.replace(/'/g, "''")}'`).join(",")
  const script = `try { $p = Start-Process -FilePath '${command}' -ArgumentList @(${list}) -Verb RunAs -Wait -PassThru; exit $p.ExitCode } catch { exit 1 }`
  return new Promise<number | undefined>((resolve) => {
    let settled = false
    const finish = (code?: number) => {
      if (settled) return
      settled = true
      resolve(code)
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn("powershell.exe", ["-NoProfile", "-WindowStyle", "Hidden", "-Command", script], { stdio: ["ignore", "ignore", "ignore"], windowsHide: true })
    } catch {
      finish()
      return
    }
    child.once("error", () => finish())
    child.once("close", (code) => finish(code ?? undefined))
  })
}

function openExternal(url: string): Promise<void> {
  const command = process.platform === "win32" ? "cmd.exe" : process.platform === "darwin" ? "open" : "xdg-open"
  const args = process.platform === "win32" ? ["/d", "/s", "/c", "start", "", url] : [url]
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true })
    child.once("error", reject)
    child.once("spawn", () => {
      child.unref()
      resolve()
    })
  })
}

async function hasPath(path: string) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function installWarp(context: Plugin.Context): Promise<boolean> {
  if (Warp.resolveCli()) {
    context.ui.toast.show({
      title: text(context, "WARP is already installed", tr("WARP is already installed")),
      message: text(context, "Use \"Route only OpenCode through WARP\" to set it up.", tr("Press “Only OpenCode through WARP…” to set it up.")),
      variant: "info",
    })
    return false
  }
  const termux = Boolean(process.env.PREFIX?.includes("/com.termux/") || process.env.TERMUX_VERSION)
  const installGuide = "https://developers.cloudflare.com/warp-client/get-started/"
  let command: string | undefined
  let args: string[] = []
  let confirmation = text(context, "This will install Cloudflare WARP using the available package manager.", tr("This installs Cloudflare WARP with the available package manager."))
  let isAUR = false

  if (termux || process.platform === "android") {
    await context.ui.dialog.alert({
      title: text(context, "WARP on Android / Termux", tr("WARP on Android / Termux")),
      message: text(context, "Cloudflare's Android VPN app is separate from the Termux CLI. Android does not support WARP Local Proxy mode for routing only OpenCode traffic, so installing the mobile app would not meet the per-app routing requirement.", tr("Cloudflare's Android app is a separate VPN client, not a CLI for Termux. WARP Local Proxy for routing only OpenCode is not supported on Android, so the mobile app cannot isolate the traffic.")),
    })
    await openExternal("https://one.one.one.one/")
    return false
  }

  if (process.platform === "win32") {
    if (!(await commandExists("winget"))) {
      await context.ui.dialog.alert({
        title: text(context, "Install WARP", tr("Installing WARP")),
        message: text(context, "Windows Package Manager (winget) was not found. Opening Cloudflare's official download page.", tr("The winget package manager was not found. Opening the official Cloudflare download page.")),
      })
      await openExternal("https://one.one.one.one/")
      return false
    }
    command = "winget"
    args = warpWingetArgs()
  } else if (process.platform === "darwin") {
    if (!(await commandExists("brew"))) {
      await context.ui.dialog.alert({
        title: text(context, "Install WARP", tr("Installing WARP")),
        message: text(context, "Homebrew was not found. Opening Cloudflare's official download page.", tr("Homebrew not found. Opening the official Cloudflare download page.")),
      })
      await openExternal("https://one.one.one.one/")
      return false
    }
    command = "brew"
    args = ["install", "--cask", "cloudflare-warp"]
  } else if (process.platform === "linux") {
    let release = ""
    try { release = await readFile("/etc/os-release", "utf8") } catch {}
    if (/ID=(arch|cachyos|manjaro|endeavouros|garuda|artix)/i.test(release) || /ID_LIKE=.*arch/i.test(release)) {
      const helper = (await commandExists("paru")) ? "paru" : (await commandExists("yay")) ? "yay" : undefined
      if (!helper) {
        await context.ui.dialog.alert({
          title: text(context, "Install WARP on Arch", tr("Installing WARP on Arch")),
          message: text(context, "No AUR helper (paru or yay) was found. Cloudflare does not publish an official Arch package; the commonly used cloudflare-warp-bin package is community-maintained. Install an AUR helper first, then retry.", tr("No AUR helper found (paru or yay). Cloudflare publishes no official Arch package; cloudflare-warp-bin is community-maintained. Install paru or yay first, then try again.")),
        })
        return false
      }
      command = helper
      args = ["-S", "--needed", "cloudflare-warp-bin"]
      isAUR = true
      confirmation = text(context, "Arch/CachyOS uses the community-maintained AUR package cloudflare-warp-bin, not an official Cloudflare repository. Continue?", tr("On Arch/CachyOS the community-maintained cloudflare-warp-bin package from the AUR is used, not an official Cloudflare repository. Continue?"))
    } else if ((await commandExists("apt-get")) && ((await hasPath("/etc/apt/sources.list.d/cloudflare-client.list")) || (await hasPath("/etc/apt/sources.list.d/cloudflare-client.sources")))) {
      command = "sudo"
      args = ["apt-get", "install", "-y", "cloudflare-warp"]
    } else if ((await commandExists("dnf")) && ((await hasPath("/etc/yum.repos.d/cloudflare-warp.repo")) || (await hasPath("/etc/yum.repos.d/cloudflare-client.repo")))) {
      command = "sudo"
      args = ["dnf", "install", "-y", "cloudflare-warp"]
    } else {
      await context.ui.dialog.alert({
        title: text(context, "Install WARP", tr("Installing WARP")),
        message: text(context, "This Linux distribution does not have the Cloudflare WARP repository configured. Opening the official installation guide: " + installGuide, tr("This Linux system has no Cloudflare WARP repository. Opening the official instructions: ") + installGuide),
      })
      await openExternal(installGuide)
      return false
    }
  } else {
    await context.ui.dialog.alert({
      title: text(context, "Install WARP", tr("Installing WARP")),
      message: text(context, "Automatic installation is not supported on this platform. See " + installGuide, tr("Automatic installation is not supported on this platform. Instructions: ") + installGuide),
    })
    await openExternal(installGuide)
    return false
  }

  const accepted = await context.ui.dialog.confirm({
    title: text(context, "Install Cloudflare WARP?", tr("Install Cloudflare WARP?")),
    message: confirmation,
    label: { confirm: text(context, "Install", tr("Install")), cancel: text(context, "Cancel", tr("Cancel")) },
  })
  if (!accepted || !command) return false
  let failure: unknown
  try {
    await runInteractive(context, command, args)
  } catch (cause) {
    // winget reports the inner installer's code, which says nothing about whether the package
    // landed; warp-cli on disk is the answer.
    if (Warp.resolveCli()) Warp.log(`installer exited with: ${messageOf(cause).slice(0, 400)} — warp-cli is present, treating the install as done`)
    else failure = cause
  }
  if (failure && command === "winget") {
    const elevated = await context.ui.dialog.confirm({
      title: text(context, "Install WARP as administrator?", tr("Install WARP as administrator?")),
      message: text(context, "The installer did not finish without administrator rights. WARP installs system-wide, so retry elevated? Windows may ask for confirmation.", tr("Installation did not finish without administrator rights. WARP installs for the whole computer; retry with rights? Windows may ask to confirm.")),
      label: { confirm: text(context, "Retry as administrator", tr("Retry as administrator")), cancel: text(context, "Cancel", tr("Cancel")) },
    })
    if (elevated) {
      const code = await runElevatedInstaller(command, args)
      if (Warp.resolveCli() || installerExitSucceeded(command, code)) failure = undefined
      else failure = new Error(`${messageOf(failure)} The elevated attempt exited with code ${String(code ?? "unknown")}.`)
    }
  }
  if (failure) {
    // Every other branch here hands the user Cloudflare's own page instead of a bare exit code,
    // and winget's words travel with the message so the code stops being the whole answer.
    Warp.log(`WARP install failed: ${messageOf(failure).slice(0, 2000)}`)
    await context.ui.dialog.alert({
      title: text(context, "WARP installation failed", tr("Could not install WARP")),
      message: text(context, "Automatic installation did not finish. The package manager reported: ", tr("Automatic installation did not finish. The package manager said: ")) + messageOf(failure) + text(context, " The official page is opening now — install WARP there, then come back.", tr(" The official page opens now; install WARP there and come back.")),
    })
    await openExternal(process.platform === "win32" ? "https://one.one.one.one/" : installGuide)
    return false
  }
  // Installing WARP must never implicitly establish a tunnel. The user enables routing explicitly.
  await Warp.run(["disconnect"]).catch(() => undefined)
  await Warp.hideGui()
  if (isAUR) {
    context.ui.toast.show({
      title: text(context, "WARP installed", tr("WARP installed")),
      message: text(context, "WARP is installed but left disconnected. Use \"Route only OpenCode through WARP…\" when you actually want it.", tr("WARP is installed but left off. Press “Only OpenCode through WARP…” when you actually want it on.")),
      variant: "success",
    })
  }
  return true
}

async function describeProxyEntries(context: Plugin.Context) {
  try {
    const entries = await context.client.config.get()
    const proxies = entries.flatMap((entry, index) => entry.type === "document" && entry.info.proxy !== undefined ? [`#${index}=${entry.info.proxy === null ? "null" : String(entry.info.proxy.http ?? "-")}`] : [])
    return `documents=${entries.length} proxies=[${proxies.join(", ")}]`
  } catch (cause) {
    return `read failed: ${messageOf(cause).slice(0, 120)}`
  }
}

async function readOpenCodeProxyPort(context: Plugin.Context): Promise<number | null | undefined> {
  try {
    const entries = await context.client.config.get()
    const found = entries.findLast((entry) => entry.type === "document" && entry.info.proxy !== undefined)
    if (!found || found.type !== "document") return null
    if (Warp.isWarpProxy(found.info.proxy, Warp.DEFAULT_PORT)) return Warp.DEFAULT_PORT
    if (Warp.isWarpProxy(found.info.proxy, Warp.HTTP_BRIDGE_PORT)) return Warp.HTTP_BRIDGE_PORT
    return null
  } catch {
    return undefined
  }
}

async function readOpenCodeProxyEnabled(context: Plugin.Context): Promise<boolean | undefined> {
  const port = await readOpenCodeProxyPort(context)
  return port === undefined ? undefined : port !== null
}

async function setOpenCodeProxy(context: Plugin.Context, enabled: boolean, port = Warp.DEFAULT_PORT) {
  await context.client.config.update({ proxy: enabled ? Warp.proxyConfig(port) : null })
}

async function setupLocalProxy(context: Plugin.Context): Promise<WarpStatus> {
  if (process.platform === "android" || process.env.PREFIX?.includes("/com.termux/")) throw new Error(text(context, "WARP Local Proxy is available on desktop clients only. Android/Termux cannot isolate WARP traffic to OpenCode this way.", tr("WARP Local Proxy exists only in the desktop client. On Android/Termux OpenCode's traffic alone cannot be routed through WARP this way.")))
  let next: WarpStatus
  try {
    next = await Warp.ensureProxy()
  } catch (cause) {
    if (!(cause instanceof Warp.WarpError && cause.code === "device-in-use")) throw cause
    const accepted = await context.ui.dialog.confirm({
      title: text(context, "WARP is routing the whole device", tr("WARP currently covers the whole device")),
      message: text(context, "WARP is connected for every application. Switch it to Local Proxy so that only OpenCode uses WARP? Other apps will go back to your normal connection.", tr("WARP is connected for every app. Switch it to Local Proxy so only OpenCode uses WARP? Other apps return to the normal connection.")),
      label: { confirm: text(context, "Only OpenCode", tr("Only OpenCode")), cancel: text(context, "Cancel", tr("Cancel")) },
    })
    if (!accepted) throw cause
    next = await Warp.ensureProxy(Warp.DEFAULT_PORT, { takeOverDevice: true })
  }
  // WARP normally serves HTTP on 40000. Only use the bridge on 40001 for SOCKS5-only clients.
  const proxyPort = (await Warp.isSocksOnly(Warp.DEFAULT_PORT)) ? Warp.HTTP_BRIDGE_PORT : Warp.DEFAULT_PORT
  await setOpenCodeProxy(context, true, proxyPort)
  return next
}

function ActionButton(props: { context: Plugin.Context; id: string; label: string; run: () => void; disabled?: boolean; emphasized?: boolean; block?: boolean; accent?: boolean }) {
  const [hovered, setHovered] = createSignal(false)
  const theme = () => props.context.theme
  const base = () => theme().text.action?.primary?.base ?? theme().text.base
  const hover = () => theme().text.action?.primary?.hovered ?? theme().increase(base(), 2)
  const background = () => {
    if (props.disabled) return undefined
    if (hovered()) return hoverBackground(theme())
    if (props.emphasized) return theme().background.raised?.base ?? theme().background.base
    return undefined
  }
  const color = () =>
    props.disabled ? theme().text.muted : hovered() ? hover() : props.emphasized || props.accent ? base() : theme().text.muted
  return (
    <box id={props.id} width={props.block ? "100%" : undefined} paddingLeft={1} paddingRight={1} backgroundColor={background()} onMouseOver={() => setHovered(!props.disabled)} onMouseOut={() => setHovered(false)} onMouseUp={(event) => { event.stopPropagation(); if (!props.disabled) props.run() }}>
      <text fg={color()} wrapMode="none" truncate>{props.emphasized ? <b>{props.label}</b> : props.label}</text>
    </box>
  )
}

export function WarpSidebar(props: { context: Plugin.Context; status: WarpStatus; busy: SharedBusy; proxyEnabled: boolean; autoRotateEnabled: boolean; autoRotation: AutoRotationState; exitIp: string; directIp: string; open: () => void; toggleProxy: () => void; toggleAutoRotate: () => void }) {
  const theme = () => props.context.theme
  const ru = () => language(props.context) === "ru"
  // The session sidebar is a narrow column, so the labels form a fixed-width column and the
  // values sit right next to it. A value too long for the panel is cut with an ellipsis
  // instead of running past the edge.
  const row = (label: string, value: string, color: ReturnType<typeof theme>["text"]["base"]) => (
    <text wrapMode="none" truncate>
      <span style={{ fg: theme().text.muted }}>{label.padEnd(LABEL_WIDTH)}</span>
      <span style={{ fg: color }}>{value}</span>
    </text>
  )
  return (
    <box gap={1}>
      <box flexDirection="row" alignItems="center" justifyContent="space-between" gap={1}>
        <text fg={theme().text.base} flexShrink={0}><b>WARP</b></text>
        <text fg={statusColor(props.context, props.status.state)} wrapMode="none" truncate>
          {"● " + statusLabel(props.context, props.status.state)}
        </text>
      </box>
      <box>
        {row(
          ru() ? tr("Route") : "Route",
          props.proxyEnabled ? (ru() ? tr("only through WARP") : "WARP only") : (ru() ? tr("direct") : "direct"),
          props.proxyEnabled ? theme().text.feedback.success.base : theme().text.base,
        )}
        {row(ru() ? tr("Your IP") : "Your IP", props.directIp || "…", theme().text.muted)}
        {props.proxyEnabled &&
          row(
            ru() ? "IP OpenCode" : "OpenCode IP",
            // The route row above already says the traffic goes through WARP, so the
            // "· WARP" tag on the address only repeats it.
            (props.exitIp || "…").replace(" · WARP", ""),
            theme().text.feedback.success.base,
          )}
        {props.autoRotateEnabled &&
          props.autoRotation.phase !== "idle" &&
          row(
            ru() ? tr("Auto IP") : "Auto IP",
            describeAutoRotation(props.autoRotation, ru()),
            props.autoRotation.phase === "changed"
              ? theme().text.feedback.success.base
              : props.autoRotation.phase === "failed"
                ? theme().text.feedback.error.base
                : props.autoRotation.phase === "paused"
                  ? theme().text.feedback.warning.base
                  : theme().text.muted,
          )}
      </box>
      <ActionButton
        context={props.context}
        id="warp.sidebar.proxy"
        label={props.proxyEnabled
          ? (ru() ? tr("✓ Turn off WARP for OpenCode") : "✓ Disable WARP for OpenCode")
          : (ru() ? tr("↗ Only OpenCode through WARP") : "↗ Route only OpenCode via WARP")}
        run={props.toggleProxy}
        disabled={props.busy.action !== null || props.status.state === "unavailable"}
        emphasized
        block
      />
      <box flexDirection="row" gap={1} flexWrap="wrap">
        <ActionButton context={props.context} id="warp.sidebar.open" label={ru() ? tr("Manage ↗") : "Manage ↗"} run={props.open} accent />
        <ActionButton context={props.context} id="warp.sidebar.autoRotate" label={ru() ? tr(props.autoRotateEnabled ? "Auto IP: ON" : "Auto IP: OFF") : `Auto IP: ${props.autoRotateEnabled ? "ON" : "OFF"}`} run={props.toggleAutoRotate} disabled={props.busy.action !== null} emphasized={props.autoRotateEnabled} accent />
      </box>
    </box>
  )
}

function WarpPage(props: { context: Plugin.Context; status: WarpStatus; busy: SharedBusy; proxyEnabled: boolean; exitIp: string; directIp: string; run: (action: WarpAction) => void; onClose: () => void }) {
  const theme = () => props.context.theme
  const ru = () => language(props.context) === "ru"
  const pending = () => props.busy.action !== null
  const working = () => {
    switch (props.busy.action) {
      case "refresh": return ru() ? tr("Checking status…") : "Checking status…"
      case "connect": return ru() ? tr("Connecting WARP…") : "Connecting WARP…"
      case "disconnect": return ru() ? tr("Disconnecting WARP…") : "Disconnecting WARP…"
      case "reconnect": return ru() ? tr("Reconnecting…") : "Reconnecting…"
      case "reset": return ru() ? tr("Resetting registration…") : "Resetting registration…"
      case "install": return ru() ? tr("Installing WARP…") : "Installing WARP…"
      case "proxy": return ru() ? tr("Setting up the OpenCode proxy…") : "Configuring OpenCode-only proxy…"
      case "disableProxy": return ru() ? tr("Removing the OpenCode proxy…") : "Disabling OpenCode proxy…"
      case "changeIp": return ru() ? tr("Changing IP…") : "Changing IP…"
      default: return ""
    }
  }

  props.context.keymap.layer(() => ({ commands: [{ bind: "escape", title: ru() ? tr("Close WARP") : "Close WARP", group: "WARP", run: props.onClose }] }))

  const reset = async () => {
    const accepted = await props.context.ui.dialog.confirm({
      title: ru() ? tr("Reset the WARP registration?") : "Reset WARP registration?",
      message: ru() ? tr("The current WARP registration is deleted and a new one created. Do not use this for corporate WARP / Zero Trust: the connection may need to be set up again. A reset does not guarantee the AI provider lifts its limit.") : "This deletes the current WARP registration and creates a new one. Do not use it with organization-managed WARP / Zero Trust: setup may need to be repeated. This does not guarantee an AI provider's rate limit will reset.",
      label: { confirm: ru() ? tr("Reset") : "Reset", cancel: ru() ? tr("Cancel") : "Cancel" },
    })
    if (accepted) props.run("reset")
  }

  return (
    <box width="100%" backgroundColor={theme().background.base} paddingLeft={1} paddingRight={1} gap={1}>
      <box flexDirection="row" justifyContent="space-between" alignItems="flex-start" gap={1}>
        <box flexGrow={1} minWidth={0}>
          <text fg={theme().text.base}><b>Cloudflare WARP</b></text>
          <text fg={theme().text.muted} wrapMode="word">{ru() ? tr("Only OpenCode's traffic goes through WARP; other apps connect directly.") : "Only OpenCode traffic goes through WARP; other apps connect directly."}</text>
        </box>
        <ActionButton context={props.context} id="warp.close" label="Esc" run={props.onClose} />
      </box>
      <box paddingLeft={1}>
        <box flexDirection="row" alignItems="center" gap={1}>
          <text fg={statusColor(props.context, props.status.state)}>●</text>
          <text fg={theme().text.base}><b>{statusLabel(props.context, props.status.state)}</b></text>
          <text fg={theme().text.muted}>{pending() ? working() : ""}</text>
        </box>
        <text fg={theme().text.muted} wrapMode="word">{props.status.state === "unavailable" ? (ru() ? tr("Cloudflare WARP is not installed. Press “Install WARP…”.") : "Cloudflare WARP is not installed. Press “Install WARP…”.") : props.status.details}</text>
        <text fg={theme().text.muted} wrapMode="none">{(ru() ? tr("Your IP: ") : "Your IP: ") + (props.directIp || "…")}</text>
        <text fg={props.exitIp ? theme().text.feedback.success.base : theme().text.muted} wrapMode="none">{(ru() ? "IP OpenCode: " : "OpenCode IP: ") + (props.exitIp || (props.proxyEnabled ? "…" : ru() ? tr("the same (WARP off)") : "same (WARP off)"))}</text>
      </box>
      <box flexDirection="row" gap={1} flexWrap="wrap">
        {props.status.state === "unavailable" && <ActionButton context={props.context} id="warp.install" label={ru() ? tr("Install WARP…") : "Install WARP…"} run={() => props.run("install")} disabled={pending()} emphasized />}
        <ActionButton context={props.context} id="warp.refresh" label={ru() ? tr("Status") : "Refresh"} run={() => props.run("refresh")} disabled={pending()} />
        {props.status.state !== "unavailable" && <ActionButton context={props.context} id="warp.connect" label={ru() ? tr("Connect") : "Connect"} run={() => props.run("connect")} disabled={pending() || props.status.state === "connected"} />}
        {props.status.state !== "unavailable" && <ActionButton context={props.context} id="warp.disconnect" label={ru() ? tr("Disconnect") : "Disconnect"} run={() => props.run("disconnect")} disabled={props.busy.action === "disconnect" || props.status.state === "disconnected"} />}
        {props.status.state !== "unavailable" && <ActionButton context={props.context} id="warp.reconnect" label={ru() ? tr("Reconnect") : "Reconnect"} run={() => props.run("reconnect")} disabled={pending()} />}
        {props.status.state !== "unavailable" && <ActionButton context={props.context} id="warp.proxy" label={props.proxyEnabled ? (ru() ? tr("Remove the OpenCode proxy") : "Disable OpenCode proxy") : (ru() ? tr("Only OpenCode through WARP…") : "Route only OpenCode through WARP…")} run={() => props.run(props.proxyEnabled ? "disableProxy" : "proxy")} disabled={pending()} emphasized={!props.proxyEnabled} />}
        {props.status.state !== "unavailable" && <ActionButton context={props.context} id="warp.changeIp" label={ru() ? tr("Change IP") : "Change IP"} run={() => props.run("changeIp")} disabled={pending() || !props.proxyEnabled} emphasized={props.proxyEnabled} />}
        {props.status.state !== "unavailable" && <ActionButton context={props.context} id="warp.reset" label={ru() ? tr("Reset registration…") : "Reset registration…"} run={() => void reset()} disabled={pending()} />}
      </box>
      <box gap={1}><text fg={theme().text.muted} wrapMode="word">{ru() ? tr("Reconnect, Change IP and Reset work in Local Proxy mode. Reset is for personal WARP only.") : "Reconnect, Change IP and Reset work in Local Proxy mode. Reset is for personal WARP only."}</text></box>
    </box>
  )
}

export default Plugin.define({
  id: "opencode.warp",
  setup(context) {
    const [status, updateStatus] = context.storage.memory<WarpStatus>("status", { initial: { state: "checking", details: "Checking Cloudflare WARP…" } })
    const [busy, updateBusy] = context.storage.memory<SharedBusy>("busy", { initial: { action: null } })
    const [proxy, updateProxy] = context.storage.memory<{ enabled: boolean }>("proxy", { initial: { enabled: false } })
    const [autoRotate, updateAutoRotate] = context.storage.store<{ enabled: boolean; optedOut?: boolean }>("autoRotate", { initial: { enabled: false } })
    const [autoRotation, updateAutoRotation] = context.storage.memory<{ state: AutoRotationState }>("autoRotation", { initial: { state: { phase: "idle" } } })
    const [exit, updateExit] = context.storage.memory<{ ip: string; direct: string }>("exit", { initial: { ip: "", direct: "" } })

    const describeIp = (seen: Warp.ExitIp | undefined) => seen ? seen.ip + (seen.warp ? " · WARP" : "") + (seen.loc ? " · " + seen.loc : "") : ""
    const refreshExitIp = async (options: { readonly force?: boolean } = {}) => {
      if (!options.force && Date.now() - lastExitIpRefresh < EXIT_IP_REFRESH_MS) return
      lastExitIpRefresh = Date.now()
      const proxyPort = proxy.enabled ? await readOpenCodeProxyPort(context) : null
      const [direct, viaWarp] = await Promise.all([
        Warp.exitIp(),
        proxy.enabled && typeof proxyPort === "number" ? Warp.exitIp(proxyPort) : Promise.resolve(undefined),
      ])
      updateExit((draft) => { if (direct) draft.direct = describeIp(direct); if (!proxy.enabled) draft.ip = ""; else draft.ip = viaWarp ? describeIp(viaWarp) : text(context, "no traffic through WARP", "нет трафика через WARP") })
    }

    let offReads = 0
    let trustUntil = 0
    let leaving = false
    let lastProxyRead = "unknown"
    let lastExitIpRefresh = 0
    let healedRoute = false
    const leave = () => {
      if (leaving) return
      leaving = true
      Warp.releaseSync({ disconnect: proxy.enabled })
    }
    const onSignal = (code: number) => () => { leave(); process.exit(code) }
    const onHup = onSignal(129)
    const onTerm = onSignal(143)
    process.once("exit", leave)
    process.once("SIGHUP", onHup)
    process.once("SIGTERM", onTerm)

    const refreshProxy = async () => {
      const enabled = await readOpenCodeProxyEnabled(context)
      // A read that fails because the server is restarting is not a state change; logging it on
      // every tick buried the diagnostic trail in identical lines.
      const read = String(enabled)
      if (read !== lastProxyRead && (enabled === undefined || enabled !== proxy.enabled)) {
        lastProxyRead = read
        Warp.log(`opencode proxy flag: stored=${proxy.enabled} read=${read} offReads=${offReads} ${await describeProxyEntries(context)}`)
      }
      if (enabled === undefined) return
      if (Date.now() < trustUntil && enabled !== proxy.enabled) return
      offReads = enabled ? 0 : offReads + 1
      if (enabled || offReads >= 2) updateProxy((draft) => { draft.enabled = enabled })
      if (enabled) {
        leaving = false
        Warp.markInUse()
        // Heal configurations that point at the 40001 bridge while WARP serves HTTP itself on 40000:
        // saved by older builds, or by a build that judged a dead tunnel to be SOCKS5-only. Nothing
        // else listens on 40001 then, so every OpenCode request fails. Retried on each refresh until
        // decided, because right after start WARP may still be connecting and 40000 not open yet.
        if (!healedRoute) {
          const configuredPort = await readOpenCodeProxyPort(context)
          if (configuredPort !== Warp.HTTP_BRIDGE_PORT) healedRoute = true
          if (configuredPort === Warp.HTTP_BRIDGE_PORT && await Warp.portOpen(Warp.DEFAULT_PORT)) {
            healedRoute = true
            if (!(await Warp.isSocksOnly(Warp.DEFAULT_PORT))) {
              await setOpenCodeProxy(context, true, Warp.DEFAULT_PORT)
              Warp.log(`repaired stale OpenCode WARP proxy port ${configuredPort} -> ${Warp.DEFAULT_PORT}`)
              await refreshExitIp({ force: true })
            }
          }
        }
      }
    }

    const refresh = async () => {
      if (busy.action !== null) return
      // Another OpenCode may have run WARP's relay and exited; this one takes it over.
      await Warp.keepRelay()
      const read = await readWarpStatus()
      setSharedStatus(updateStatus, read)
      await refreshProxy()
      // WARP is intentionally NOT auto-reconnected. A user disconnect must stay disconnected.
      await refreshExitIp()
    }

    let rateLimitRotationRequested = false
    let rateLimitRotationRunning = false
    let rateLimitRotationTimer: ReturnType<typeof setTimeout> | undefined
    const gate = createRotationGate()
    const continuations = createRateLimitContinuations()
    // A provider limit often clears within a minute or two, so a delayed continuation is what keeps
    // chats moving when a rotation changed nothing. The last delay repeats.
    const CONTINUATION_RETRY_DELAYS_MS = [90_000, 180_000, 600_000]
    let continuationRetryIndex = 0
    let continuationRetryTimer: ReturnType<typeof setTimeout> | undefined
    const setAutoRotation = (value: AutoRotationState) => updateAutoRotation((draft) => { draft.state = value })
    // Zen caps the free tier per address and model, so a model refused from this address stays
    // refused for every chat until the address changes; fallbacks skip those models.
    const cappedModels = new Set<string>()
    let autoEnabling = false
    // A failed automatic switch-on is not retried on every capped request: WARP that cannot reach
    // Cloudflare would otherwise be put back into "connecting" again and again.
    let autoRouteFailedAt = 0
    let leavingWarp = false
    // When WARP's shared exits hit the cap, WARP is not switched back on for the cap for a while.
    let warpCappedAt = 0
    const WARP_CAP_MEMORY_MS = 6 * 60 * 60 * 1_000
    const AUTO_ROUTE_RETRY_MS = 15 * 60 * 1_000

    const scheduleContinuationRetry = () => {
      if (continuationRetryTimer) return
      const delay = CONTINUATION_RETRY_DELAYS_MS[Math.min(continuationRetryIndex, CONTINUATION_RETRY_DELAYS_MS.length - 1)]
      Warp.log(`automatic continuation retry in ${Math.round(delay / 1000)}s (attempt ${continuationRetryIndex + 1})`)
      continuationRetryTimer = setTimeout(() => {
        continuationRetryTimer = undefined
        continuationRetryIndex++
        // A chat stopped by the per-address cap can only move on from another address, so it asks
        // for a rotation instead of a prompt that would spend a request against the same cap.
        if (continuations.due({ addressChanged: true }).length > continuations.due().length) {
          rateLimitRotationRequested = true
          void runQueuedRateLimitRotation()
        }
        void resumeRateLimitedChats({})
      }, delay)
    }

    const scheduleRateLimitRotation = (delay: number) => {
      // A storm of failures must not keep pushing the rotation back: an already scheduled attempt
      // recomputes the remaining cooldown when it runs, so the earliest timer wins.
      if (rateLimitRotationTimer) return
      rateLimitRotationTimer = setTimeout(() => {
        rateLimitRotationTimer = undefined
        void runQueuedRateLimitRotation()
      }, delay)
    }

    async function runQueuedRateLimitRotation() {
      if (!rateLimitRotationRequested || rateLimitRotationRunning) return
      if (busy.action !== null) {
        // A user action or the startup route repair owns WARP right now. Keep the request and look
        // again shortly instead of dropping it, so every chat that hit the limit is still resumed.
        Warp.log("automatic IP rotation deferred: another WARP action is running")
        scheduleRateLimitRotation(1_000)
        return
      }
      if (!autoRotate.enabled) {
        rateLimitRotationRequested = false
        continuations.clear()
        return
      }
      const decision = gate.decide()
      if (!decision.run && decision.reason === "cooldown") {
        // A failure inside the cooldown used to drop the request, so chats that hit the limit right
        // after another rotation were never resumed. Wait the cooldown out and keep the request.
        scheduleRateLimitRotation(decision.retryIn)
        return
      }
      if (!decision.run) {
        rateLimitRotationRequested = false
        Warp.log(`automatic IP rotation skipped: ${decision.reason} until ${new Date(decision.until).toISOString()}`)
        setAutoRotation({ phase: "paused", at: Date.now(), reason: decision.reason, until: decision.until })
        await resumeRateLimitedChats({ fallback: "rotation-paused" })
        // The queue is still worth a delayed try: the provider limit can clear while the tunnel
        // itself is left alone.
        if (continuations.due({ addressChanged: true }).length > 0) scheduleContinuationRetry()
        return
      }

      rateLimitRotationRunning = true
      rateLimitRotationRequested = false
      setSharedBusy(updateBusy, "changeIp")
      try {
        // Verify the actual config rather than relying only on cached panel state. Repair the route
        // first so a stale 40001 setting cannot make every MCP/provider request fail with ECONNREFUSED.
        const proxyReady = (await readOpenCodeProxyEnabled(context)) === true
        if (!proxyReady || !autoRotate.enabled) {
          Warp.log(`automatic IP rotation skipped: proxy=${proxyReady} autoRotate=${autoRotate.enabled}`)
          // Without the OpenCode proxy there is nothing to rotate, but the chat still deserves its
          // automatic continuation once the provider limit clears.
          await resumeRateLimitedChats({ fallback: "warp-unavailable" })
          if (continuations.due({ addressChanged: true }).length > 0) scheduleContinuationRetry()
          return
        }
        if ((await Warp.mode()).mode !== "proxy") {
          throw new Warp.WarpError("not-proxy-mode", text(context, "WARP must be in Local Proxy mode for automatic IP changes.", tr("Automatic IP change needs WARP in Local Proxy mode.")))
        }
        const ready = await setupLocalProxy(context)
        setSharedStatus(updateStatus, ready)
        updateProxy((draft) => { draft.enabled = true })
        gate.started()
        setAutoRotation({ phase: "rotating", at: Date.now() })
        context.ui.toast.show({
          title: text(context, "Provider/network error detected", tr("Network error detected")),
          message: text(context, "Repairing the WARP route and changing the OpenCode exit IP…", tr("Fixing the WARP route and changing OpenCode's exit IP…")),
          variant: "info",
        })
        const rotation = await Warp.rotate()
        gate.finished(rotation.changed)
        if (rotation.changed) continuationRetryIndex = 0
        const next = gate.decide()
        setAutoRotation(
          rotation.changed || next.run || next.reason === "cooldown"
            ? { phase: "changed", at: Date.now(), from: rotation.before?.ip, to: rotation.after?.ip }
            : { phase: "paused", at: Date.now(), reason: next.reason, until: next.until },
        )
        setSharedStatus(updateStatus, rotation.status)
        await refreshProxy()
        await refreshExitIp({ force: true })
        context.ui.toast.show({
          title: text(context, "Automatic IP change finished", tr("Automatic IP change finished")),
          message: rotation.changed
            ? text(context, "OpenCode now uses a different WARP exit IP.", tr("OpenCode now uses a different WARP exit IP."))
            : text(context, "WARP reconnected, but a new IP could not be confirmed. The provider may still apply the same limit.", tr("WARP reconnected, but the new IP could not be confirmed. The provider may keep applying the same limit.")),
          variant: rotation.changed ? "success" : "info",
        })
        if (rotation.changed) cappedModels.clear()
        await resumeRateLimitedChats({ rotation })
        if (!rotation.changed) await resumeRateLimitedChats({ fallback: "address-unchanged" })
        // Chats held by the address cap stay queued after a rotation that kept the address; the
        // delayed retry asks again once the gate's backoff lets the tunnel be tried once more.
        if (continuations.due({ addressChanged: true }).length > 0) scheduleContinuationRetry()
      } catch (cause) {
        setAutoRotation({ phase: "failed", at: Date.now(), message: describe(context, cause) })
        context.ui.toast.show({
          title: text(context, "Automatic IP change failed", tr("Could not change the IP automatically")),
          message: describe(context, cause),
          variant: "error",
        })
        await resumeRateLimitedChats({ fallback: "warp-unavailable" })
      } finally {
        rateLimitRotationRunning = false
        setSharedBusy(updateBusy, null)
        if (rateLimitRotationRequested) void runQueuedRateLimitRotation()
      }
    }

    /**
     * WARP only changes the address; the session that hit the limit stays stopped until someone prompts
     * it again. This asks every chat that stopped on the limit to continue, in the same way the
     * "Continue work" link does, but bounded so a provider that keeps refusing is not hammered.
     *
     * With `fallback`, the address could not be changed: only chats held by the per-address cap are
     * continued, each on another free model of its provider, and the user is told why it changed.
     */
    async function resumeRateLimitedChats(options: { readonly rotation?: Pick<Warp.Rotation, "before" | "after" | "changed">; readonly fallback?: "rotation-paused" | "address-unchanged" | "warp-unavailable"; readonly direct?: boolean }) {
      const rotation = options.rotation
      if (!autoRotate.enabled && !options.fallback && !options.direct) {
        continuations.clear()
        return
      }
      const plain = new Set(continuations.due())
      const due = options.fallback
        ? continuations.due({ addressChanged: true }).filter((sessionID) => !plain.has(sessionID))
        : continuations.due({ addressChanged: rotation?.changed === true || options.direct === true })
      if (due.length === 0) return
      // On some networks WARP keeps the same exit address even after a new registration (measured:
      // reconnect, new registration and four different tunnel endpoints all returned one IP), so an
      // unchanged address must not block the continuation. The queue still bounds how often one chat
      // is resumed.
      if (rotation)
        Warp.log(
          `automatic continuation: exit ${rotation.before?.ip ?? "?"} -> ${rotation.after?.ip ?? "?"} changed=${rotation.changed} due=${due.length}`,
        )
      let resumed = 0
      for (const sessionID of due) {
        const session = context.data.session.get(sessionID)
        // A subagent session cannot be prompted directly; its parent continues the task.
        if (session?.parentID) {
          continuations.forget(sessionID)
          continue
        }
        if (context.data.session.status(sessionID) === "running") continue
        try {
          await context.data.session.message.invalidate(sessionID)
          await context.data.session.message.sync(sessionID)
          const messages = context.data.session.message.list(sessionID)
          const latest = messages.findLast((message) => message.type === "assistant")
          // The server already scheduled its own retry: sending a prompt now would race it and can
          // duplicate the work the retry is about to do.
          if (latest?.type === "assistant" && latest.retry && latest.retry.at > Date.now()) continue
          // The transcript is the source of truth: a newer user or assistant message means the chat is
          // already moving and a second prompt would duplicate work.
          if (!latest || !isRateLimitedTurnPending(messages, latest.id)) {
            continuations.forget(sessionID)
            continue
          }
          const current = latest.type === "assistant" ? latest.model : session?.model
          const replacement = options.fallback && session && current ? await fallbackModel(session.location, current) : undefined
          if (options.fallback && !replacement) {
            Warp.log(`automatic model fallback skipped for ${sessionID}: no other free model left for ${current ? modelKey(current) : "?"}`)
            continue
          }
          // Claim only now: every skip above means nothing was sent, and burning an attempt for it
          // would exhaust the allowance of a chat that never got a continuation.
          if (!continuations.claim(sessionID)) {
            Warp.log(`automatic continuation skipped for ${sessionID}: no attempts left`)
            continue
          }
          try {
            if (replacement) await context.client.session.switchModel({ sessionID, model: { providerID: replacement.providerID, id: replacement.modelID } })
            await context.client.session.prompt({ sessionID, text: RATE_LIMIT_CONTINUATION_PROMPT })
          } catch (cause) {
            // Nothing confirmed reached the chat, so the claim and its allowance must come back;
            // otherwise the session would stay stopped with no new failure to queue it again. An
            // ambiguous failure (server accepted, client lost the answer) is re-checked against the
            // transcript before the next prompt by isRateLimitedTurnPending, so it cannot double-run.
            continuations.release(sessionID)
            throw cause
          }
          continuations.commit(sessionID)
          resumed++
          if (replacement && options.fallback) announceFallback(session?.title, current, replacement.name, options.fallback)
        } catch (cause) {
          Warp.log(`automatic continuation failed for ${sessionID}: ${messageOf(cause).slice(0, 200)}`)
        }
      }
      if (resumed === 0 || options.fallback) return
      continuationRetryIndex = 0
      context.ui.toast.show({
        title: text(context, "Rate limit: chats resumed", tr("Provider limit: chats continue")),
        message: text(
          context,
          `${resumed} ${resumed === 1 ? "chat" : "chats"} stopped by the rate limit continue automatically.`,
          tr(resumed === 1 ? "{count} chat stopped by the limit continues automatically." : "{count} chats stopped by the limit continue automatically.", { count: resumed }),
        ),
        variant: "success",
      })
    }

    async function fallbackModel(location: { readonly directory: string }, current: { readonly providerID: string; readonly id: string }) {
      await context.data.location.model.sync(location)
      return pickFallbackModel(context.data.location.model.list(location) ?? [], current, cappedModels)
    }

    function announceFallback(title: string | undefined, from: { readonly id: string } | undefined, to: string, reason: "rotation-paused" | "address-unchanged" | "warp-unavailable") {
      const why = {
        "rotation-paused": text(context, "WARP already changed the IP recently without effect, so it is paused.", tr("WARP recently changed the IP without effect and is paused.")),
        "address-unchanged": text(context, "WARP reconnected but kept the same IP.", tr("WARP reconnected, but the IP stayed the same.")),
        "warp-unavailable": text(context, "WARP could not change the IP.", tr("WARP could not change the IP.")),
      }[reason]
      context.ui.toast.show({
        title: text(context, "Model changed: free-tier IP limit", tr("Model switched: free plan IP limit")),
        message:
          (title ? `«${title}»: ` : "") +
          `${from?.id ?? "?"} → ${to}. ` +
          text(context, "Zen's free tier for this model is used up on this IP. ", tr("The free Zen limit for this model on this IP is used up. ")) +
          why,
        variant: "warning",
        duration: 15_000,
      })
    }

    /**
     * The per-address cap is the case Auto IP exists for, so it switches OpenCode-only WARP routing and
     * Auto IP on by itself unless the user turned Auto IP off. A device-wide tunnel is never taken
     * over silently, and anything that stops WARP here sends the chat to another free model instead.
     */
    async function enableAutoRouteForCap() {
      if (autoEnabling) return
      if (busy.action !== null) {
        setTimeout(() => void enableAutoRouteForCap(), 1_000)
        return
      }
      if (autoRotate.optedOut || !Warp.resolveCli() || Date.now() - autoRouteFailedAt < AUTO_ROUTE_RETRY_MS) {
        Warp.log(`automatic WARP switch-on skipped: optedOut=${autoRotate.optedOut === true} cli=${Boolean(Warp.resolveCli())}`)
        await resumeRateLimitedChats({ fallback: "warp-unavailable" })
        return
      }
      autoEnabling = true
      setSharedBusy(updateBusy, "proxy")
      setAutoRotation({ phase: "rotating", at: Date.now() })
      try {
        const ready = await Warp.ensureProxy(Warp.DEFAULT_PORT)
        const proxyPort = (await Warp.isSocksOnly(Warp.DEFAULT_PORT)) ? Warp.HTTP_BRIDGE_PORT : Warp.DEFAULT_PORT
        offReads = 0
        trustUntil = Date.now() + 30_000
        await setOpenCodeProxy(context, true, proxyPort)
        setSharedStatus(updateStatus, ready)
        updateProxy((draft) => { draft.enabled = true })
        await updateAutoRotate((draft) => { draft.enabled = true })
        const [before, after] = await Promise.all([Warp.exitIp(), Warp.exitIp(proxyPort)])
        await refreshExitIp({ force: true })
        Warp.log(`automatic WARP switch-on for the free-tier cap: direct=${before?.ip ?? "?"} warp=${after?.ip ?? "?"}`)
        context.ui.toast.show({
          title: text(context, "Free-tier IP limit: WARP switched on", tr("Free plan IP limit: WARP turned on")),
          message: text(context, "Only OpenCode now goes through WARP, and Auto IP is on. Other apps are unchanged.", tr("Only OpenCode goes through WARP now, Auto IP is on. Other apps are not affected.")),
          variant: "info",
        })
        const changed = Boolean(before && after && before.ip !== after.ip)
        if (!changed) {
          // WARP answers from the same address as the direct route, so it still needs a real rotation.
          rateLimitRotationRequested = true
          return
        }
        // Moving onto WARP already is the change of address the capped chats were waiting for.
        cappedModels.clear()
        setAutoRotation({ phase: "changed", at: Date.now(), from: before?.ip, to: after?.ip })
        await resumeRateLimitedChats({ rotation: { before, after, changed } })
      } catch (cause) {
        autoRouteFailedAt = Date.now()
        Warp.log(`automatic WARP switch-on failed: ${messageOf(cause).slice(0, 200)}`)
        setAutoRotation({ phase: "failed", at: Date.now(), message: describe(context, cause) })
        await resumeRateLimitedChats({ fallback: "warp-unavailable" })
      } finally {
        autoEnabling = false
        setSharedBusy(updateBusy, null)
        if (rateLimitRotationRequested) void runQueuedRateLimitRotation()
      }
    }

    const queueAutoRotation = (error: unknown) => {
      if (!isAutoRotationFailure(error) || !autoRotate.enabled) return
      rateLimitRotationRequested = true
      void runQueuedRateLimitRotation()
    }

    /**
     * WARP exits are shared Cloudflare addresses that thousands of people use, so Zen's per-address free
     * cap is usually spent on them while the operator's own address still has its allowance. A cap hit
     * through WARP therefore moves OpenCode back to the direct route instead of rotating among WARP exits.
     */
    async function leaveWarpForCap() {
      if (leavingWarp) return
      if (busy.action !== null) {
        setTimeout(() => void leaveWarpForCap(), 1_000)
        return
      }
      leavingWarp = true
      warpCappedAt = Date.now()
      setSharedBusy(updateBusy, "disableProxy")
      try {
        await setOpenCodeProxy(context, false)
        updateProxy((draft) => { draft.enabled = false })
        await updateAutoRotate((draft) => {
          draft.enabled = false
          draft.optedOut = true
        })
        Warp.releaseSync({ disconnect: false })
        cappedModels.clear()
        await refreshExitIp({ force: true })
        Warp.log("free-tier cap through WARP: OpenCode switched back to the direct route")
        context.ui.toast.show({
          title: text(context, "Free-tier limit on WARP: switched to direct", tr("Free plan limit on WARP: switched to direct")),
          message: text(context, "WARP's shared addresses had used up Zen's free allowance, so OpenCode now connects directly from your own address.", tr("WARP's shared addresses had used up Zen's free allowance, so OpenCode now connects directly from your own address.")),
          variant: "info",
        })
        await resumeRateLimitedChats({ direct: true })
      } catch (cause) {
        Warp.log(`switching back to the direct route failed: ${messageOf(cause).slice(0, 200)}`)
      } finally {
        leavingWarp = false
        setSharedBusy(updateBusy, null)
      }
    }

    const onAddressCap = async (error: unknown) => {
      if ((await readOpenCodeProxyEnabled(context)) === true) return leaveWarpForCap()
      // Both routes are capped when WARP was just left for this: another free model is the only way on.
      if (Date.now() - warpCappedAt < WARP_CAP_MEMORY_MS) return resumeRateLimitedChats({ fallback: "warp-unavailable" })
      if (!autoRotate.enabled) return enableAutoRouteForCap()
      queueAutoRotation(error)
    }

    const onProviderFailure = (sessionID: string, error: unknown) => {
      if (isAddressCapFailure(error)) {
        const model = context.data.session.get(sessionID)?.model
        if (model) cappedModels.add(modelKey(model))
        // A chat stopped by the cap is always queued, so it is continued on a new address or, failing
        // that, on another free model, whether or not Auto IP was on when the cap arrived.
        continuations.record(sessionID, { addressCap: true })
        void onAddressCap(error)
        return
      }
      if (autoRotate.enabled && isRateLimitFailure(error)) {
        // Retry scheduling fires before the terminal failure, so both signals must feed the same
        // queue; otherwise a chat that stopped after the last retry would never be resumed.
        continuations.record(sessionID)
      }
      queueAutoRotation(error)
    }

    // Both failure signals share one queue and one cooldown: retry.scheduled fires per retry and
    // execution.failed per terminal failure, so separate handlers rotated twice for one incident.
    const disposeRateLimit = context.data.on("session.execution.failed", (event) => onProviderFailure(event.data.sessionID, event.data.error))
    const disposeRetry = context.data.on("session.retry.scheduled", (event) => onProviderFailure(event.data.sessionID, event.data.error))

    const perform = async (action: WarpAction) => {
      // Disconnect may interrupt whatever is running: it is how the user stops a connection that hangs.
      if (busy.action !== null && !(action === "disconnect" && busy.action !== "disconnect")) return
      if (action === "disconnect") {
        // Turning WARP off by hand also stops the automatic switch-on for the free-tier cap; Auto IP turns it back on.
        await updateAutoRotate((draft) => {
          draft.enabled = false
          draft.optedOut = true
        })
      }
      setSharedBusy(updateBusy, action)
      if (action === "proxy" || action === "disableProxy") { offReads = 0; trustUntil = Date.now() + 30_000 }
      try {
        let next: WarpStatus
        let actionMessage: string | undefined
        let infoOnly = false
        if (action === "install") {
          const installed = await installWarp(context)
          infoOnly = !installed
          next = await readWarpStatus()
          actionMessage = installed ? text(context, "Installer finished. WARP remains disconnected until you explicitly enable OpenCode-only routing.", tr("The installer finished. WARP stays off until you explicitly turn on routing for OpenCode only.")) : text(context, "Opened installation guidance. WARP is not confirmed installed yet.", tr("The installation guide is open. WARP installation is not confirmed yet."))
        } else if (action === "proxy") {
          next = await setupLocalProxy(context)
          updateProxy((draft) => { draft.enabled = true })
          actionMessage = text(context, "Only OpenCode is configured to use WARP. Other apps are unchanged.", tr("Only OpenCode is set to use WARP. Other apps' settings are unchanged."))
        } else if (action === "disableProxy") {
          await setOpenCodeProxy(context, false)
          updateProxy((draft) => { draft.enabled = false })
          Warp.releaseSync({ disconnect: false })
          next = await readWarpStatus()
          actionMessage = text(context, "OpenCode now connects directly. Other apps were not changed.", tr("OpenCode now connects directly. Other apps' settings are unchanged."))
        } else if (action === "changeIp") {
          gate.started()
          const rotation = await Warp.rotate()
          gate.finished(rotation.changed)
          if (rotation.changed) setAutoRotation({ phase: "changed", at: Date.now(), from: rotation.before?.ip, to: rotation.after?.ip })
          next = rotation.status
          actionMessage = rotation.changed
            ? text(context, "OpenCode now uses a different WARP exit IP.", tr("OpenCode now uses a different WARP exit IP."))
            : text(context, "WARP reconnected, but a new IP could not be confirmed.", tr("WARP reconnected, but the new IP could not be confirmed."))
          await refreshProxy()
          await refreshExitIp({ force: true })
          if (rotation.changed) cappedModels.clear()
          await resumeRateLimitedChats({ rotation })
        } else {
          next = await performWarpAction(action, context)
        }
        setSharedStatus(updateStatus, next)
        if (action !== "refresh") {
          context.ui.toast.show({ title: text(context, "WARP action finished", tr("WARP operation finished")), message: actionMessage ?? (statusLabel(context, next.state) + ": " + next.details.slice(0, 240)), variant: infoOnly ? "info" : action === "install" || action === "proxy" || action === "disableProxy" ? "success" : next.state === "connected" ? "success" : "info" })
        }
      } catch (cause) {
        const message = describe(context, cause)
        setSharedStatus(updateStatus, action === "install" ? await readWarpStatus() : warpStatusError(message))
        context.ui.toast.show({ title: text(context, "WARP action failed", tr("WARP error")), message, variant: "error" })
      } finally {
        setSharedBusy(updateBusy, null)
        if (rateLimitRotationRequested) void runQueuedRateLimitRotation()
      }
    }

    const toggleAutoRotate = async () => {
      if (busy.action !== null) return
      const enabled = !autoRotate.enabled
      try {
        if (enabled) {
          // Always reconcile the configured endpoint, including stale settings from earlier builds.
          const next = await setupLocalProxy(context)
          setSharedStatus(updateStatus, next)
          updateProxy((draft) => { draft.enabled = true })
          await refreshExitIp()
        }
        await updateAutoRotate((draft) => {
          draft.enabled = enabled
          draft.optedOut = !enabled
        })
        context.ui.toast.show({
          title: enabled ? text(context, "Auto IP enabled", tr("Auto IP change on")) : text(context, "Auto IP disabled", tr("Auto IP change off")),
          message: enabled
            ? text(context, "WARP will change IP on RateLimit and transient connection errors such as ECONNREFUSED.", tr("WARP will change the IP on RateLimit and on temporary network errors such as ECONNREFUSED."))
            : text(context, "WARP will keep its current IP until you change it manually.", tr("WARP keeps the current IP until you change it by hand.")),
          variant: "info",
        })
      } catch (cause) {
        context.ui.toast.show({ title: text(context, "Could not save Auto IP setting", tr("Could not save the auto IP setting")), message: messageOf(cause), variant: "error" })
      }
    }

    const close = () => context.ui.dialog.clear()
    const open = () => {
      context.ui.dialog.show(() => <WarpPage context={context} status={status} busy={busy} proxyEnabled={proxy.enabled} exitIp={exit.ip} directIp={exit.direct} run={(action) => void perform(action)} onClose={close} />)
      context.ui.dialog.set({ size: "medium", centered: true })
    }

    context.ui.slot({ append: "app", render() {
      context.keymap.layer(() => ({ mode: "global", commands: [{ id: "opencode.warp.open", title: text(context, "Cloudflare WARP controls", tr("Cloudflare WARP control")), description: text(context, "View status, connect, reconnect, or reset registration", tr("Status, connect, reconnect and registration reset")), group: "System", slash: { name: "warp", arguments: true }, palette: true, run: open }] }))
      return null
    }})
    context.ui.slot({ append: "sidebar.content", render: () => <WarpSidebar context={context} status={status} busy={busy} proxyEnabled={proxy.enabled} autoRotateEnabled={autoRotate.enabled} autoRotation={autoRotation.state} exitIp={exit.ip} directIp={exit.direct} open={open} toggleProxy={() => void perform(proxy.enabled ? "disableProxy" : "proxy")} toggleAutoRotate={() => void toggleAutoRotate()} /> })

    void Warp.hideGui()
    void refresh()
    void refreshProxy()
    // The stored proxy setting is the user's standing intent: after a reboot or a warp-svc
    // restart the tunnel is down while OpenCode still routes through 127.0.0.1:40000, so every
    // request fails with ECONNREFUSED until someone presses the button. Bring it back once per
    // session. Never touches a device-wide tunnel (ensureProxy refuses that) and never starts
    // the background service itself, so no surprise UAC prompt appears.
    const healSavedRoute = async () => {
      if (busy.action !== null) return
      if ((await readOpenCodeProxyEnabled(context)) !== true) return
      if (!Warp.resolveCli()) return
      setSharedBusy(updateBusy, "proxy")
      try {
        await Warp.ensureProxy(Warp.DEFAULT_PORT)
        const proxyPort = (await Warp.isSocksOnly(Warp.DEFAULT_PORT)) ? Warp.HTTP_BRIDGE_PORT : Warp.DEFAULT_PORT
        await setOpenCodeProxy(context, true, proxyPort)
        setSharedStatus(updateStatus, await Warp.status())
        updateProxy((draft) => { draft.enabled = true })
        await refreshExitIp({ force: true })
        context.ui.toast.show({
          title: text(context, "WARP route restored", tr("WARP route restored")),
          message: text(context, "OpenCode is routed through WARP again. Other apps are unchanged.", tr("OpenCode goes through WARP again. Other apps' settings are unchanged.")),
          variant: "success",
        })
      } catch (cause) {
        Warp.log(`startup route restore skipped: ${messageOf(cause).slice(0, 200)}`)
        setSharedStatus(updateStatus, warpStatusError(describe(context, cause)))
      } finally {
        setSharedBusy(updateBusy, null)
      }
    }
    void healSavedRoute()
    const timer = setInterval(() => void refresh(), STATUS_REFRESH_MS)

    return () => {
      clearInterval(timer)
      if (rateLimitRotationTimer) clearTimeout(rateLimitRotationTimer)
      if (continuationRetryTimer) clearTimeout(continuationRetryTimer)
      continuations.clear()
      disposeRateLimit()
      disposeRetry()
      process.off("exit", leave)
      process.off("SIGHUP", onHup)
      process.off("SIGTERM", onTerm)
    }
  },
})