export * as DesktopActionTool from "./desktop-action.js"

import { dlopen, FFIType } from "bun:ffi"
import { ToolFailure } from "@orchestra/ai"
import type { Context } from "@orchestra/plugin/effect/plugin"
import { optional } from "@orchestra/schema/schema"
import { Effect, Schema } from "effect"
import { DesktopIsolation } from "../../desktop-isolation.js"
import { isDesktopCaptureEnabled, makeHost } from "./desktop.js"
import { bunRuntime } from "../../runtime.js"

export const name = "desktop_action"

export const description = [
  "Act on the screen by name instead of by guessed pixel: press a button in a window, put the keyboard into a field, type into it, or send a media key to whatever player is running.",
  "",
  "B7: this tool reads and drives the operator's REAL screen through Windows UI Automation — there is no virtual display for it. It needs the real-screen opt-in (ORCHESTRA_DESKTOP_REAL_SCREEN=on, allowlist naming the app, future expiry) on top of ORCHESTRA_DESKTOP_CAPTURE=on. Without it the call is refused; use the desktop_* tools on the virtual display instead.",
  "",
  "Actions:",
  "  click — the centre of the element named by target (or of the window itself when target is omitted).",
  "  invoke — the element's own Invoke, Toggle or Select pattern, the way assistive tools press a control.",
  "  focus — keyboard focus on the element, and the window brought to the front.",
  "  type — the text into the element: ValuePattern when the field offers one, otherwise focus plus a paste.",
  "  media — play_pause, play, pause, next, prev or mute as a Windows media key, in milliseconds and without touching focus.",
  "",
  "app picks the window by part of its title or by its process name; omit it to act on the window that already has the focus.",
  "target is a control name, its text, or its automation id. Read what is on the screen first with desktop_inspect, which",
  "reports the same names this tool accepts.",
  "",
  "Windows does not expose separate play and pause keys: both, like play_pause, send the same toggle. This works on real",
  "Win32/UWP controls; a canvas or a page drawn inside Electron has no elements to name, so use a screenshot for those.",
].join("\n")

export const Input = Schema.Struct({
  action: Schema.Literals(["click", "invoke", "type", "focus", "media"]),
  /** Part of a window title or a process name. Omit to use the window that has the focus. */
  app: optional(Schema.String),
  /** Element name, text or automation id. Omit to act on the window itself. */
  target: optional(Schema.String),
  /** The text to type, for action "type". */
  text: optional(Schema.String),
  /** Media key to send, for action "media". */
  command: optional(Schema.Literals(["play_pause", "play", "pause", "next", "prev", "mute"])),
})
export type Input = typeof Input.Type
export type MediaCommand = NonNullable<Input["command"]>

export const Output = Schema.Struct({ output: Schema.String })
export type Output = typeof Output.Type

/** Windows virtual-key codes for the media keys. There is one play/pause toggle, not two keys. */
export const MEDIA_KEY = {
  play_pause: 0xb3,
  play: 0xb3,
  pause: 0xb3,
  next: 0xb0,
  prev: 0xb1,
  mute: 0xad,
} as const satisfies Record<MediaCommand, number>

const KEYEVENTF_KEYUP = 0x0002

export interface ActionWindow {
  readonly title: string
  readonly processId: number
  readonly process: string
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

export interface ActionElement {
  readonly name: string
  readonly type: string
  readonly automationId: string
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

export interface ActionResult {
  readonly action: string
  readonly method: string
  readonly window: ActionWindow
  readonly element: ActionElement
  readonly point?: { readonly x: number; readonly y: number }
}

const RawWindow = Schema.Struct({
  title: Schema.NullOr(Schema.String),
  processId: Schema.Number,
  process: Schema.NullOr(Schema.String),
  x: Schema.Number,
  y: Schema.Number,
  w: Schema.Number,
  h: Schema.Number,
})

const RawElement = Schema.Struct({
  name: Schema.NullOr(Schema.String),
  type: Schema.NullOr(Schema.String),
  automationId: Schema.NullOr(Schema.String),
  x: Schema.Number,
  y: Schema.Number,
  w: Schema.Number,
  h: Schema.Number,
})

const RawResult = Schema.Struct({
  action: Schema.String,
  method: Schema.String,
  window: RawWindow,
  element: RawElement,
  point: Schema.optional(Schema.NullOr(Schema.Struct({ x: Schema.Number, y: Schema.Number }))),
})

export const LIMIT = 2048

const UNSUPPORTED =
  "desktop_action needs Windows UI Automation and Windows media keys, which this platform does not have. Use desktop_screenshot and desktop_click instead."

/** Answers a tool failure before any window is touched, so a malformed call never half-acts. */
export function validate(input: Input): string | undefined {
  if (input.action === "media") {
    if (input.command === undefined)
      return 'desktop_action with action "media" needs a command: play_pause, play, pause, next, prev or mute.'
    return undefined
  }
  if (input.action === "type" && (input.text === undefined || input.text === ""))
    return 'desktop_action with action "type" needs the text to type.'
  return undefined
}

export function parseResult(raw: string): ActionResult {
  const text = raw.trim()
  if (text === "") throw new Error("the action helper returned no data")
  const decoded = Schema.decodeUnknownSync(RawResult)(JSON.parse(text))
  return {
    action: decoded.action,
    method: decoded.method,
    window: {
      title: decoded.window.title ?? "",
      processId: decoded.window.processId,
      process: decoded.window.process ?? "",
      x: decoded.window.x,
      y: decoded.window.y,
      w: decoded.window.w,
      h: decoded.window.h,
    },
    element: {
      name: decoded.element.name ?? "",
      type: decoded.element.type ?? "",
      automationId: decoded.element.automationId ?? "",
      x: decoded.element.x,
      y: decoded.element.y,
      w: decoded.element.w,
      h: decoded.element.h,
    },
    ...(decoded.point === undefined || decoded.point === null
      ? {}
      : { point: { x: decoded.point.x, y: decoded.point.y } }),
  }
}

// The helper answers `Invoke-Action -Action 'click' -App 'Calc' -Target 'num7' -Text ''`; every value is a
// PowerShell single-quoted string, so a quote or a newline in a control name cannot end the argument early.
export function buildScript(input: Input) {
  return [
    "Invoke-Action",
    `-Action ${psString(input.action)}`,
    `-App ${psString(input.app?.trim() ?? "")}`,
    `-Target ${psString(input.target?.trim() ?? "")}`,
    `-Text ${psString(input.text ?? "")}`,
  ].join(" ")
}

export function renderResult(result: ActionResult) {
  const window = `"${result.window.title}" [${result.window.process || "process"} ${result.window.processId}]`
  const element = describeElement(result.element)
  if (result.action === "click")
    return clip(
      result.point === undefined
        ? `clicked ${window} at its centre (${result.method}).`
        : `clicked ${element} in ${window} @ ${result.point.x},${result.point.y} (${result.method}).`,
    )
  if (result.action === "invoke") return clip(`invoked ${element} in ${window} via ${result.method}.`)
  if (result.action === "focus") return clip(`focused ${element} in ${window} via ${result.method}.`)
  return clip(`typed into ${element} in ${window} via ${result.method}.`)
}

export function renderMedia(command: MediaCommand) {
  const vk = MEDIA_KEY[command]
  const note = command === "play" || command === "pause" ? " (Windows has one play/pause toggle)" : ""
  return `sent media ${command} as VK 0x${vk.toString(16).toUpperCase()}${note}.`
}

/** True when user32.dll exposes keybd_event, i.e. media keys can be sent from this process. */
export function mediaLibraryReady() {
  if (process.platform !== "win32") return false
  try {
    return typeof user32().keybd_event === "function"
  } catch {
    return false
  }
}

/** Sends one media key without focus, a shell, or a window: key down, key up. */
export function pressMedia(command: MediaCommand) {
  pressVirtualKey(MEDIA_KEY[command])
}

/** Exposed for the test that proves the FFI call itself works without pressing a real media key. */
export function pressVirtualKey(code: number) {
  const symbols = user32()
  symbols.keybd_event(code, 0, 0, 0)
  symbols.keybd_event(code, 0, KEYEVENTF_KEYUP, 0)
}

let cached: ReturnType<typeof openUser32> | undefined

function user32() {
  cached ??= openUser32()
  return cached
}

function openUser32() {
  return dlopen("user32.dll", {
    keybd_event: { args: [FFIType.u8, FFIType.u8, FFIType.u32, FFIType.ptr], returns: FFIType.void },
  }).symbols
}

function describeElement(element: ActionElement) {
  const label = element.name.trim() === "" ? element.automationId || "the element" : element.name
  return `"${label}"${element.type === "" ? "" : ` (${element.type})`}`
}

const psString = (text: string) => `'${text.replaceAll("'", "''")}'`

function clip(text: string, limit = LIMIT) {
  if (text.length <= limit) return text
  return `${text.slice(0, limit - 24).trimEnd()}\n... (truncated)`
}

// The helper finds the window, brings it to the front, resolves the target and acts on it. It is a separate
// PowerShell process from desktop_inspect on purpose: an action must never wait behind a slow screen walk.
export const ACTION_PRELUDE = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class OcAction {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, int x, int y, int d, IntPtr e);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint f, IntPtr e);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
}
'@
[void][OcAction]::SetProcessDPIAware()

$script:WalkBudget = 4000
$script:WalkDeadline = $null

function Send-Reply([string]$tag, [string]$text) {
  [Console]::Out.WriteLine('@@' + $tag + ' ' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($text)))
  [Console]::Out.Flush()
}

function Invoke-Step([string]$encoded) {
  try {
    $script = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encoded))
    $result = & ([ScriptBlock]::Create($script)) | Out-String
    Send-Reply 'OK' $result.Trim()
  } catch {
    Send-Reply 'ERR' $_.Exception.Message
  }
}

function Get-Rect($element) {
  try { $rect = $element.Current.BoundingRectangle } catch { return $null }
  if ($rect.IsEmpty) { return $null }
  if ($rect.Width -lt 2 -or $rect.Height -lt 2) { return $null }
  if ($rect.X -lt -12000 -or $rect.Y -lt -12000) { return $null }
  try { if ($element.Current.IsOffscreen) { return $null } } catch { return $null }
  return $rect
}

function Get-TopWindows {
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $condition = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Window)
  return $root.FindAll([System.Windows.Automation.TreeScope]::Children, $condition)
}

function Get-WindowOf($element) {
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $node = $element
  while ($null -ne $node) {
    try {
      if ($node.Current.ControlType -eq [System.Windows.Automation.ControlType]::Window) { return $node }
      $node = $walker.GetParent($node)
    } catch { return $element }
  }
  return $element
}

function Test-AppMatch($window, [string]$App) {
  $title = ''
  try { $title = '' + $window.Current.Name } catch {}
  if ($title -like ('*' + $App + '*')) { return $true }
  $owner = Get-WindowProcess $window
  if ($owner.process -ne '' -and $owner.process -like ('*' + $App + '*')) { return $true }
  return $false
}

# A UWP app such as Calculator is hosted by ApplicationFrameHost; the real process owns a child Window
# of the frame, so the name the operator knows only appears one level down.
function Get-WindowProcess($window) {
  $processId = 0
  try { $processId = [int]$window.Current.ProcessId } catch {}
  $process = ''
  try { $process = (Get-Process -Id $processId -ErrorAction Stop).ProcessName } catch {}
  if ($process -ne 'ApplicationFrameHost') { return [pscustomobject]@{ processId = $processId; process = $process } }
  $condition = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Window)
  try {
    foreach ($child in $window.FindAll([System.Windows.Automation.TreeScope]::Children, $condition)) {
      $childId = 0
      try { $childId = [int]$child.Current.ProcessId } catch { continue }
      if ($childId -eq $processId) { continue }
      $childName = ''
      try { $childName = (Get-Process -Id $childId -ErrorAction Stop).ProcessName } catch { continue }
      if ($childName -ne 'ApplicationFrameHost') { return [pscustomobject]@{ processId = $childId; process = $childName } }
    }
  } catch {}
  return [pscustomobject]@{ processId = $processId; process = $process }
}

function Find-Window([string]$App) {
  if ($App -eq '') {
    $focused = [System.Windows.Automation.AutomationElement]::FocusedElement
    if ($null -eq $focused) { throw 'No window has the keyboard focus; pass app to name the window.' }
    return Get-WindowOf $focused
  }
  foreach ($item in (Get-TopWindows)) {
    if (Test-AppMatch $item $App) { return $item }
  }
  throw ('No window matches "' + $App + '".')
}

function Find-ByName($node, [string]$Target, [int]$depth) {
  if ($depth -gt 8 -or $script:WalkBudget -le 0) { return $null }
  if ($null -ne $script:WalkDeadline -and [DateTime]::UtcNow -gt $script:WalkDeadline) { return $null }
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $child = $walker.GetFirstChild($node)
  while ($null -ne $child) {
    $script:WalkBudget--
    if ($script:WalkBudget -le 0) { return $null }
    $name = ''
    try { $name = '' + $child.Current.Name } catch {}
    if ($name -like ('*' + $Target + '*') -and $null -ne (Get-Rect $child)) { return $child }
    $deeper = Find-ByName $child $Target ($depth + 1)
    if ($null -ne $deeper) { return $deeper }
    $child = $walker.GetNextSibling($child)
  }
  return $null
}

function Find-Target($window, [string]$Target) {
  if ($Target -eq '') { return $window }
  $byName = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NameProperty, $Target)
  $byID = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::AutomationIdProperty, $Target)
  $exact = [System.Windows.Automation.OrCondition]::new($byName, $byID)
  try {
    foreach ($item in $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $exact)) {
      if ($null -ne (Get-Rect $item)) { return $item }
    }
  } catch {}
  $script:WalkBudget = 4000
  $script:WalkDeadline = [DateTime]::UtcNow.AddMilliseconds(1500)
  $found = Find-ByName $window $Target 0
  $script:WalkDeadline = $null
  if ($null -ne $found) { return $found }
  throw ('No element in the window matches "' + $Target + '".')
}

function Activate-Window($window) {
  try {
    $handle = [IntPtr]$window.Current.NativeWindowHandle
    if ($handle -ne [IntPtr]::Zero) {
      [void][OcAction]::ShowWindow($handle, 9)
      [void][OcAction]::SetForegroundWindow($handle)
    }
  } catch {}
  Start-Sleep -Milliseconds 30
}

function Send-Click([int]$x, [int]$y) {
  [void][OcAction]::SetCursorPos($x, $y)
  Start-Sleep -Milliseconds 10
  [OcAction]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero)
  [OcAction]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero)
  return [pscustomobject]@{ x = $x; y = $y }
}

function Click-Element($element) {
  $rect = Get-Rect $element
  if ($null -eq $rect) { throw 'The element has no clickable rectangle; it may be offscreen or minimised.' }
  return Send-Click ([int][Math]::Round($rect.X + $rect.Width / 2)) ([int][Math]::Round($rect.Y + $rect.Height / 2))
}

function Invoke-Element($element) {
  $pattern = $null
  if ($element.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pattern) -and $null -ne $pattern) {
    $pattern.Invoke()
    return 'InvokePattern'
  }
  $toggle = $null
  if ($element.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$toggle) -and $null -ne $toggle) {
    $toggle.Toggle()
    return 'TogglePattern'
  }
  $selection = $null
  if ($element.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$selection) -and $null -ne $selection) {
    $selection.Select()
    return 'SelectionItemPattern'
  }
  throw 'The element supports no Invoke, Toggle or Select pattern; use action "click" instead.'
}

function Focus-Element($element) {
  $element.SetFocus()
  return 'SetFocus'
}

function Set-Value($element, [string]$Text) {
  $value = $null
  if ($element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$value) -and $null -ne $value) {
    if (-not $value.Current.IsReadOnly) {
      $value.SetValue($Text)
      return $true
    }
  }
  return $false
}

# The field the operator means is the first writable Edit/Document inside the window, not the window itself.
function Find-Editable($window) {
  $condition = [System.Windows.Automation.OrCondition]::new(
    ([System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Edit)),
    ([System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Document)))
  try {
    foreach ($item in $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)) {
      $value = $null
      if ($item.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$value) -and $null -ne $value -and -not $value.Current.IsReadOnly) {
        return $item
      }
    }
  } catch {}
  return $null
}

# A background process may not take the foreground. The Alt tap unlocks SetForegroundWindow, and the result
# is verified: a paste that would land in another window is refused instead of typing into the operator's app.
function Force-Foreground($window) {
  $handle = [IntPtr]$window.Current.NativeWindowHandle
  if ($handle -eq [IntPtr]::Zero) { return $false }
  [void][OcAction]::ShowWindow($handle, 9)
  [OcAction]::keybd_event(0x12, 0, 0, [IntPtr]::Zero)
  [void][OcAction]::SetForegroundWindow($handle)
  [OcAction]::keybd_event(0x12, 0, 2, [IntPtr]::Zero)
  Start-Sleep -Milliseconds 100
  return ([OcAction]::GetForegroundWindow() -eq $handle)
}

function Paste-Text($window, $element, [string]$Text) {
  if (-not (Force-Foreground $window)) {
    throw ('Could not bring "' + $window.Current.Name + '" to the front, so nothing was typed.')
  }
  try { $element.SetFocus() } catch {}
  Start-Sleep -Milliseconds 100
  $previous = $null
  try { $previous = Get-Clipboard -Raw -Format Text } catch {}
  Set-Clipboard -Value $Text
  Start-Sleep -Milliseconds 60
  [OcAction]::keybd_event(0x11, 0, 0, [IntPtr]::Zero)
  [OcAction]::keybd_event(0x56, 0, 0, [IntPtr]::Zero)
  [OcAction]::keybd_event(0x56, 0, 2, [IntPtr]::Zero)
  [OcAction]::keybd_event(0x11, 0, 2, [IntPtr]::Zero)
  Start-Sleep -Milliseconds 120
  if ($null -ne $previous) { Set-Clipboard -Value $previous } else { Set-Clipboard -Value '' }
  return 'ClipboardPaste'
}

function Get-Entry($element) {
  $rect = Get-Rect $element
  $name = ''
  try { $name = ('' + $element.Current.Name) -replace '\\s+', ' ' } catch {}
  $type = ''
  try { $type = ('' + $element.Current.ControlType.ProgrammaticName) -replace '^ControlType\\.', '' } catch {}
  $auto = ''
  try { $auto = '' + $element.Current.AutomationId } catch {}
  $x = 0; $y = 0; $w = 0; $h = 0
  if ($null -ne $rect) {
    $x = [int][Math]::Round($rect.X)
    $y = [int][Math]::Round($rect.Y)
    $w = [int][Math]::Round($rect.Width)
    $h = [int][Math]::Round($rect.Height)
  }
  return [pscustomobject]@{ name = $name.Trim(); type = $type; automationId = $auto; x = $x; y = $y; w = $w; h = $h }
}

function ConvertTo-Window($window) {
  $rect = $null
  try { $rect = $window.Current.BoundingRectangle } catch {}
  $title = ''
  try { $title = ('' + $window.Current.Name) -replace '\\s+', ' ' } catch {}
  $owner = Get-WindowProcess $window
  $processId = $owner.processId
  $process = $owner.process
  $x = 0; $y = 0; $w = 0; $h = 0
  if ($null -ne $rect -and -not $rect.IsEmpty) {
    $x = [int][Math]::Round($rect.X)
    $y = [int][Math]::Round($rect.Y)
    $w = [int][Math]::Round($rect.Width)
    $h = [int][Math]::Round($rect.Height)
  }
  return [pscustomobject]@{ title = $title.Trim(); processId = $processId; process = $process; x = $x; y = $y; w = $w; h = $h }
}

function Invoke-Action([string]$Action, [string]$App, [string]$Target, [string]$Text) {
  $window = Find-Window $App
  Activate-Window $window
  $element = Find-Target $window $Target
  $method = ''
  $point = $null

  if ($Action -eq 'click') {
    if ($Target -eq '') {
      $rect = Get-Rect $window
      if ($null -eq $rect) { throw 'The window has no clickable rectangle.' }
      $point = Send-Click ([int][Math]::Round($rect.X + $rect.Width / 2)) ([int][Math]::Round($rect.Y + $rect.Height / 2))
    } else {
      $point = Click-Element $element
    }
    $method = 'Mouse'
  } elseif ($Action -eq 'invoke') {
    $method = Invoke-Element $element
  } elseif ($Action -eq 'focus') {
    $method = Focus-Element $element
  } elseif ($Action -eq 'type') {
    $editable = $null
    if (Set-Value $element $Text) {
      $method = 'ValuePattern'
    } else {
      if ($Target -eq '') {
        $editable = Find-Editable $window
        if ($null -ne $editable -and (Set-Value $editable $Text)) {
          $element = $editable
          $method = 'ValuePattern'
        }
      }
      if ($method -eq '') {
        if ($null -ne $editable) { $element = $editable }
        $method = Paste-Text $window $element $Text
      }
    }
  } else {
    throw ('Unknown action "' + $Action + '".')
  }

  $report = [ordered]@{
    action = $Action
    method = $method
    window = ConvertTo-Window $window
    element = Get-Entry $element
    point = $point
  }
  return (ConvertTo-Json -InputObject $report -Depth 6 -Compress)
}
`

export const Plugin = {
  id: "orchestra.tool.desktop-action",
  effect: Effect.fn("DesktopActionTool.Plugin")(function* (ctx: Context) {
    const host = makeHost(ACTION_PRELUDE, "desktop_action")
    yield* Effect.addFinalizer(() => Effect.sync(() => host.close()))

    const run = Effect.fn("DesktopActionTool.run")(function* (input: Input) {
      if (!isDesktopCaptureEnabled()) {
        return yield* new ToolFailure({
          message: "Desktop access is off by default. Set ORCHESTRA_DESKTOP_CAPTURE=on to allow it.",
        })
      }
      // B7: UI Automation drives the operator's real screen, so this tool
      // needs the real-screen opt-in for the app it would touch.
      const denial = DesktopIsolation.realScreenDenial(process.env, input.app)
      if (denial) return yield* new ToolFailure({ message: `desktop_action is blocked: ${denial}` })
      if (process.platform !== "win32") return { output: UNSUPPORTED }
      const invalid = validate(input)
      if (invalid !== undefined) return yield* new ToolFailure({ message: invalid })

      if (input.action === "media") {
        const command = input.command!
        // Media keys go through Bun FFI (user32 keybd_event); a build without
        // Bun FFI cannot send them. The PowerShell actions below are unaffected.
        if (!bunRuntime())
          return yield* new ToolFailure({
            message:
              'desktop_action with action "media" sends Windows media keys through Bun FFI, which this build does not have. Use the Bun build for media keys.',
          })
        return yield* Effect.try({
          try: () => {
            pressMedia(command)
            return { output: renderMedia(command) }
          },
          catch: (error) =>
            new ToolFailure({ message: `desktop_action could not send the media key: ${message(error)}`, error }),
        })
      }

      const raw = yield* Effect.tryPromise({
        try: () => host.call(buildScript(input)),
        catch: (error) => new ToolFailure({ message: `desktop_action failed: ${message(error)}`, error }),
      })
      const result = yield* Effect.try({
        try: () => parseResult(raw),
        catch: (error) =>
          new ToolFailure({ message: `desktop_action returned unreadable data: ${message(error)}`, error }),
      })
      return { output: renderResult(result) }
    })

    yield* ctx.tool
      .transform((editor) =>
        editor.add({
          name,
          options: { codemode: false, core: true },
          description,
          input: Input,
          output: Output,
          execute: (value) => run(value).pipe(Effect.map((output) => ({ output, content: output.output }))),
        }),
      )
      .pipe(Effect.orDie)
  }),
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
