export * as DesktopInspectTool from "./desktop-inspect.js"

import { ToolFailure } from "@orchestra/ai"
import type { Context } from "@orchestra/plugin/effect/plugin"
import { optional } from "@orchestra/schema/schema"
import { Effect, Schema } from "effect"
import { DesktopIsolation } from "../../desktop-isolation.js"
import { isDesktopCaptureEnabled, makeHost } from "./desktop.js"

const BROWSER_HINT = " To see or drive the page the user has open in the Browser tab, load and use the `browser` tool (info, text, screenshot, click, type): it works without real-screen access."

export const name = "desktop_inspect"

export const description = [
  "Read the screen as a structure instead of pixels: the windows on the desktop and the controls inside them, with the exact click point of each one.",
  "",
  "B7: this tool reads the operator's REAL screen through Windows UI Automation — there is no virtual display for it. It needs the real-screen opt-in (ORCHESTRA_DESKTOP_REAL_SCREEN=on, non-empty allowlist, future expiry) on top of ORCHESTRA_DESKTOP_CAPTURE=on. Without it the call is refused; use desktop_screenshot on the virtual display instead.",
  "",
  "Actions:",
  "  focused вЂ” the window that has the keyboard focus and its interactive controls.",
  "  screen вЂ” the visible windows and the key controls of each one.",
  "  find вЂ” every control whose name contains the query, with the coordinates to click.",
  "",
  "Every control is reported as `name (Type) @ X,Y WxH`, where X,Y is the centre of the control in real screen pixels:",
  "pass `screen: true` to desktop_click with those values to hit the control without a screenshot.",
  "This reads Windows UI Automation, so it is instant compared with a screenshot, but it only sees real Win32/UWP",
  "windows: a canvas, a game or a browser page drawn by a web app shows only its frame, and a screenshot is still the",
  "only way to see inside one.",
].join("\n")

export const Input = Schema.Struct({
  action: Schema.Literals(["focused", "screen", "find"]),
  /** Text a control name must contain, for the find action. */
  query: optional(Schema.String),
  /** How many controls to return: 40 by default, 200 at most. */
  limit: optional(Schema.Number),
})
export type Input = typeof Input.Type

export const Output = Schema.Struct({ output: Schema.String })
export type Output = typeof Output.Type

export interface InspectElement {
  readonly name: string
  readonly type: string
  readonly automationId: string
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
  /** Centre of the control, the point a click has to hit. */
  readonly centerX: number
  readonly centerY: number
  readonly enabled: boolean
}

export interface InspectWindow {
  readonly title: string
  readonly processId: number
  readonly handle?: number
  readonly className: string
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
  readonly elements: readonly InspectElement[]
}

export interface InspectReport {
  readonly action: string
  readonly query?: string
  readonly window?: InspectWindow
  readonly windows: readonly InspectWindow[]
  readonly elements: readonly InspectElement[]
  readonly truncated: boolean
  readonly scanned: number
}

const RawElement = Schema.Struct({
  name: Schema.NullOr(Schema.String),
  type: Schema.String,
  automationId: Schema.NullOr(Schema.String),
  x: Schema.Number,
  y: Schema.Number,
  w: Schema.Number,
  h: Schema.Number,
  enabled: Schema.NullOr(Schema.Boolean),
})

const RawWindow = Schema.Struct({
  title: Schema.NullOr(Schema.String),
  processId: Schema.Number,
  handle: Schema.optional(Schema.NullOr(Schema.Number)),
  class: Schema.NullOr(Schema.String),
  x: Schema.Number,
  y: Schema.Number,
  w: Schema.Number,
  h: Schema.Number,
  elements: Schema.optional(Schema.NullOr(Schema.Array(RawElement))),
})

const RawReport = Schema.Struct({
  action: Schema.String,
  query: Schema.optional(Schema.NullOr(Schema.String)),
  window: Schema.optional(Schema.NullOr(RawWindow)),
  windows: Schema.optional(Schema.NullOr(Schema.Array(RawWindow))),
  elements: Schema.optional(Schema.NullOr(Schema.Array(RawElement))),
  truncated: Schema.optional(Schema.NullOr(Schema.Boolean)),
  scanned: Schema.optional(Schema.NullOr(Schema.Number)),
})

export const DEFAULT_LIMIT = 40
export const MAX_LIMIT = 200
export const LIMIT = 4096

export const UNSUPPORTED =
  "desktop_inspect needs Windows UI Automation, which this platform does not have. Use desktop_screenshot and desktop_click instead."

// Parses the JSON the helper prints. The helper writes one object, so a report is valid or the call failed.
export function parseReport(raw: string): InspectReport {
  const text = raw.trim()
  if (text === "") throw new Error("the inspect helper returned no data")
  const decoded = Schema.decodeUnknownSync(RawReport)(JSON.parse(text))
  const elements = (decoded.elements ?? []).map(toElement)
  return {
    action: decoded.action,
    ...(decoded.query === undefined || decoded.query === null || decoded.query === "" ? {} : { query: decoded.query }),
    ...(decoded.window === undefined || decoded.window === null ? {} : { window: toWindow(decoded.window, elements) }),
    windows: (decoded.windows ?? []).map((window) => toWindow(window)),
    elements,
    truncated: decoded.truncated ?? false,
    scanned: decoded.scanned ?? 0,
  }
}

// The helper answers `Invoke-Inspect -Action 'focused' -Query 'Save' -Limit 40`; the query is a PowerShell
// string, so a quote in a control name cannot end it early.
export function buildScript(action: Input["action"], query: string, limit: number) {
  return `Invoke-Inspect -Action ${psString(action)} -Query ${psString(query)} -Limit ${clamp(limit)}`
}

export function renderReport(report: InspectReport): string {
  if (report.action === "screen") return clip(renderScreen(report))
  if (report.action === "find") return clip(renderFind(report))
  return clip(renderFocused(report))
}

function renderFocused(report: InspectReport) {
  if (report.elements.length === 0) return "No interactive controls in the focused window."
  return [
    report.window === undefined ? "focused window" : `focused "${report.window.title}"${describeWindow(report.window)}`,
    `${report.elements.length} interactive control(s):`,
    ...report.elements.map(describeElement),
    ...(report.truncated ? [`... (truncated after ${report.scanned} element(s) scanned)`] : []),
  ].join("\n")
}

function renderScreen(report: InspectReport) {
  if (report.windows.length === 0) return "No visible windows."
  return [
    `${report.windows.length} window(s):`,
    ...report.windows.flatMap((window) => [
      `  "${window.title}"${describeWindow(window)}`,
      ...(window.elements.length === 0
        ? ["    (no interactive controls)"]
        : window.elements.map((element) => `    ${describeElement(element).trimStart()}`)),
    ]),
    ...(report.truncated ? [`... (truncated after ${report.scanned} element(s) scanned)`] : []),
  ].join("\n")
}

function renderFind(report: InspectReport) {
  const query = report.query ?? ""
  if (report.elements.length === 0)
    return report.truncated
      ? `No element matches "${query}" among the ${report.scanned} element(s) the time budget allowed.`
      : `No element matches "${query}".`
  return [
    `${report.elements.length} match(es) for "${query}":`,
    ...report.elements.map(describeElement),
    ...(report.truncated ? [`... (truncated after ${report.scanned} element(s) scanned)`] : []),
  ].join("\n")
}

function describeElement(element: InspectElement) {
  const label = element.name.trim() === "" ? "(unnamed)" : element.name
  return `  ${label}  (${element.type})  @ ${element.centerX},${element.centerY}  ${element.w}x${element.h}${element.enabled ? "" : "  disabled"}`
}

function describeWindow(window: InspectWindow) {
  const hwnd = window.handle ? ` hwnd 0x${window.handle.toString(16)}` : ""
  return ` [pid ${window.processId}${hwnd}] at ${window.x},${window.y} ${window.w}x${window.h}`
}

function toElement(raw: typeof RawElement.Type): InspectElement {
  return {
    name: raw.name ?? "",
    type: raw.type,
    automationId: raw.automationId ?? "",
    x: raw.x,
    y: raw.y,
    w: raw.w,
    h: raw.h,
    centerX: Math.round(raw.x + raw.w / 2),
    centerY: Math.round(raw.y + raw.h / 2),
    enabled: raw.enabled ?? true,
  }
}

function toWindow(raw: typeof RawWindow.Type, fallback?: readonly InspectElement[]): InspectWindow {
  return {
    title: raw.title ?? "",
    processId: raw.processId,
    handle: raw.handle ?? 0,
    className: raw.class ?? "",
    x: raw.x,
    y: raw.y,
    w: raw.w,
    h: raw.h,
    elements: raw.elements === undefined || raw.elements === null ? (fallback ?? []) : raw.elements.map(toElement),
  }
}

const psString = (text: string) => `'${text.replaceAll("'", "''")}'`

const clamp = (limit: number) => {
  const value = Math.trunc(Number.isFinite(limit) ? limit : DEFAULT_LIMIT)
  return Math.min(MAX_LIMIT, Math.max(1, value))
}

function clip(text: string, limit = LIMIT) {
  if (text.length <= limit) return text
  return `${text.slice(0, limit - 24).trimEnd()}\n... (truncated)`
}

// The helper walks the UI Automation tree with a hard node budget: a window with a web view or a large list
// can hold tens of thousands of nodes, and the point of the tool is an answer in milliseconds.
export const INSPECT_PRELUDE = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class OcInspect {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
'@
[void][OcInspect]::SetProcessDPIAware()

$script:InteractiveTypes = @('Button','CheckBox','ComboBox','DataItem','Edit','Hyperlink','ListItem','MenuItem','RadioButton','Slider','Spinner','SplitButton','TabItem','TreeItem')
$script:Seen = 0
$script:Budget = 6000
$script:MaxDepth = 8
$script:ScreenRect = $null
$script:Deadline = $null

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

function ConvertTo-Entry($element) {
  $rect = Get-Rect $element
  if ($null -eq $rect) { return $null }
  if ($null -ne $script:ScreenRect) {
    $point = [System.Windows.Point]::new(($rect.X + $rect.Width / 2), ($rect.Y + $rect.Height / 2))
    if (-not $script:ScreenRect.Contains($point)) { return $null }
  }
  $name = ''
  try { $name = '' + $element.Current.Name } catch {}
  $name = ($name -replace '\\s+', ' ').Trim()
  $auto = ''
  try { $auto = '' + $element.Current.AutomationId } catch {}
  $type = ''
  try { $type = ('' + $element.Current.ControlType.ProgrammaticName) -replace '^ControlType\\.', '' } catch {}
  $enabled = $true
  try { $enabled = [bool]$element.Current.IsEnabled } catch {}
  return [pscustomobject]@{
    name = $name
    type = $type
    automationId = $auto
    x = [int][Math]::Round($rect.X)
    y = [int][Math]::Round($rect.Y)
    w = [int][Math]::Round($rect.Width)
    h = [int][Math]::Round($rect.Height)
    enabled = $enabled
  }
}

function ConvertTo-Window($element, $elements) {
  $rect = $element.Current.BoundingRectangle
  $title = ''
  try { $title = ('' + $element.Current.Name) -replace '\\s+', ' ' } catch {}
  $class = ''
  try { $class = '' + $element.Current.ClassName } catch {}
  $x = 0; $y = 0; $w = 0; $h = 0
  if ($null -ne $rect -and -not $rect.IsEmpty) {
    $x = [int][Math]::Round($rect.X)
    $y = [int][Math]::Round($rect.Y)
    $w = [int][Math]::Round($rect.Width)
    $h = [int][Math]::Round($rect.Height)
  }
  $processId = 0
  try { $processId = [int]$element.Current.ProcessId } catch {}
  $handle = 0
  try { $handle = [int64]$element.Current.NativeWindowHandle } catch {}
  return [pscustomobject]@{
    title = $title.Trim()
    processId = $processId
    handle = $handle
    class = $class
    x = $x
    y = $y
    w = $w
    h = $h
    elements = @($elements)
  }
}

function Add-Children($node, [int]$depth, $found, [int]$limit, [string]$query) {
  if ($depth -gt $script:MaxDepth) { return }
  if ($script:Seen -ge $script:Budget) { return }
  if ($found.Count -ge $limit) { return }
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $child = $walker.GetFirstChild($node)
  while ($null -ne $child) {
    if ($script:Seen -ge $script:Budget -or $found.Count -ge $limit) { return }
    if ($null -ne $script:Deadline -and [DateTime]::UtcNow -gt $script:Deadline) { return }
    $script:Seen++
    if ($query -ne '') {
      $name = ''
      try { $name = '' + $child.Current.Name } catch {}
      if ($name -like ('*' + $query + '*')) {
        $entry = ConvertTo-Entry $child
        if ($null -ne $entry) {
          [void]$found.Add($entry)
          if ($found.Count -ge $limit) { return }
        }
      }
    } else {
      $entry = ConvertTo-Entry $child
      if ($null -ne $entry -and ($script:InteractiveTypes -contains $entry.type)) {
        [void]$found.Add($entry)
        if ($found.Count -ge $limit) { return }
      }
    }
    Add-Children $child ($depth + 1) $found $limit $query
    $child = $walker.GetNextSibling($child)
  }
}

function Get-TopWindows {
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $condition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Window)
  return $root.FindAll([System.Windows.Automation.TreeScope]::Children, $condition)
}

function Find-WindowOf($element) {
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

function Invoke-Inspect([string]$Action, [string]$Query, [int]$Limit) {
  if ($Limit -lt 1) { $Limit = 40 }
  if ($Limit -gt 200) { $Limit = 200 }
  $script:Seen = 0
  $script:ScreenRect = $null
  $script:Deadline = $null
  try { $script:ScreenRect = [System.Windows.Automation.AutomationElement]::RootElement.Current.BoundingRectangle } catch {}
  $elements = New-Object System.Collections.ArrayList
  $windows = New-Object System.Collections.ArrayList
  $window = $null
  $truncated = $false

  if ($Action -eq 'focused') {
    $focused = [System.Windows.Automation.AutomationElement]::FocusedElement
    if ($null -eq $focused) { throw 'No window has the keyboard focus.' }
    $target = Find-WindowOf $focused
    Add-Children $target 0 $elements $Limit $Query
    $window = ConvertTo-Window $target $elements
    $truncated = $script:Seen -ge $script:Budget
  } elseif ($Action -eq 'screen') {
    $collection = Get-TopWindows
    $count = 0
    $seenWindows = @{}
    foreach ($item in $collection) {
      if ($count -ge 6) { $truncated = $true; break }
      if ($null -eq (Get-Rect $item)) { continue }
      $built = ConvertTo-Window $item @()
      if ($built.title -eq '') { continue }
      $key = '' + $built.processId + '|' + $built.title + '|' + $built.x + '|' + $built.y + '|' + $built.w + '|' + $built.h
      if ($seenWindows.ContainsKey($key)) { continue }
      $seenWindows[$key] = $true
      $own = New-Object System.Collections.ArrayList
      Add-Children $item 0 $own $Limit ''
      [void]$windows.Add((ConvertTo-Window $item $own))
      $count++
    }
  } else {
    # An exact name or automation id is one native query; only a substring needs the walk.
    $nameCondition = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NameProperty, $Query)
    $idCondition = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::AutomationIdProperty, $Query)
    $exact = [System.Windows.Automation.OrCondition]::new($nameCondition, $idCondition)
    try {
      $found = [System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Descendants, $exact)
      foreach ($item in $found) {
        $entry = ConvertTo-Entry $item
        if ($null -ne $entry) {
          [void]$elements.Add($entry)
          if ($elements.Count -ge $Limit) { break }
        }
      }
    } catch {}
    if ($elements.Count -eq 0) {
      $script:Budget = 1500
      $script:Deadline = [DateTime]::UtcNow.AddMilliseconds(1200)
      # The window the operator is looking at answers first; the rest of the desktop follows.
      $active = [System.Windows.Automation.AutomationElement]::FocusedElement
      if ($null -ne $active) {
        Add-Children (Find-WindowOf $active) 0 $elements $Limit $Query
      }
      $collection = Get-TopWindows
      $count = 0
      foreach ($item in $collection) {
        if ($elements.Count -ge $Limit) { break }
        if ($count -ge 8) { $truncated = $true; break }
        if ($null -eq (Get-Rect $item)) { continue }
        $count++
        Add-Children $item 0 $elements $Limit $Query
      }
      if ($script:Seen -ge $script:Budget) { $truncated = $true }
      if ([DateTime]::UtcNow -ge $script:Deadline) { $truncated = $true }
    }
  }

  $report = [ordered]@{
    action = $Action
    query = $Query
    window = $window
    windows = @($windows)
    elements = @($elements)
    truncated = $truncated
    scanned = $script:Seen
  }
  return (ConvertTo-Json -InputObject $report -Depth 6 -Compress)
}
`

export const Plugin = {
  id: "orchestra.tool.desktop-inspect",
  effect: Effect.fn("DesktopInspectTool.Plugin")(function* (ctx: Context) {
    const host = makeHost(INSPECT_PRELUDE, "desktop_inspect")
    yield* Effect.addFinalizer(() => Effect.sync(() => host.close()))

    const run = Effect.fn("DesktopInspectTool.run")(function* (input: Input) {
      if (!isDesktopCaptureEnabled()) {
        return yield* new ToolFailure({
          message: "Desktop access is off by default. Set ORCHESTRA_DESKTOP_CAPTURE=on to allow it.",
        })
      }
      // B7: UI Automation reads the operator's real screen, so this tool
      // needs the real-screen opt-in (no single app to name: any non-empty
      // allowlist with a future expiry will do).
      const denial = DesktopIsolation.realScreenDenial(process.env)
      if (denial) return yield* new ToolFailure({ message: `desktop_inspect is blocked: ${denial}${BROWSER_HINT}` })
      if (process.platform !== "win32") return { output: UNSUPPORTED }
      const query = input.query?.trim() ?? ""
      if (input.action === "find" && query === "")
        return yield* new ToolFailure({ message: 'desktop_inspect with action "find" needs a query.' })

      const raw = yield* Effect.tryPromise({
        try: () => host.call(buildScript(input.action, query, clamp(input.limit ?? DEFAULT_LIMIT))),
        catch: (error) => new ToolFailure({ message: `desktop_inspect failed: ${message(error)}`, error }),
      })
      const report = yield* Effect.try({
        try: () => parseReport(raw),
        catch: (error) =>
          new ToolFailure({ message: `desktop_inspect returned unreadable data: ${message(error)}`, error }),
      })
      return { output: renderReport(report) }
    })

    yield* ctx.tool
      .transform((editor) =>
        editor.add({
          name,
          options: { codemode: false },
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
