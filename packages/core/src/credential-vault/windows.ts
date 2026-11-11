import { spawn } from "node:child_process"

export interface SealedInput { name: string; site: string; blob: string; backend: "windows-dpapi-user-v1" }
export interface WindowStatus { handle: number; visible: boolean; foreground: boolean; x: number; y: number; width: number; height: number }
export interface Collector { collect(existing?: { name: string; site: string }, signal?: AbortSignal, onReady?: (status?: WindowStatus) => void): Promise<SealedInput | undefined> }

// Only ciphertext crosses stdout. Password/login stay in this operator-owned
// native process, never in tool args, TUI key events, model context or shell env.
// Keep this an ordinary template: bundlers escape Cyrillic as JavaScript Unicode
// sequences. String.raw would pass those escapes literally to PowerShell.
export const SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
try {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  Add-Type -AssemblyName System.Security
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class OrchestraVaultWindow {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hwnd, int cmd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, IntPtr pid);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  [StructLayout(LayoutKind.Sequential)] public struct FLASHWINFO { public uint size; public IntPtr hwnd; public uint flags; public uint count; public uint timeout; }
  [DllImport("user32.dll")] public static extern bool FlashWindowEx(ref FLASHWINFO info);
  public static bool Raise(IntPtr hwnd) {
    ShowWindow(hwnd, 9);
    uint current = GetCurrentThreadId();
    uint foreground = GetWindowThreadProcessId(GetForegroundWindow(), IntPtr.Zero);
    bool attached = false;
    try {
      if (foreground != 0 && foreground != current) attached = AttachThreadInput(current, foreground, true);
      SetForegroundWindow(hwnd);
    } finally { if (attached) AttachThreadInput(current, foreground, false); }
    bool focused = GetForegroundWindow() == hwnd;
    if (!focused) { var flash = new FLASHWINFO { size = (uint)Marshal.SizeOf(typeof(FLASHWINFO)), hwnd = hwnd, flags = 3, count = 5, timeout = 0 }; FlashWindowEx(ref flash); }
    return focused;
  }
}
'@
  $meta = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $f = New-Object System.Windows.Forms.Form
  $f.Text = 'Orchestra Vault'; $f.ShowInTaskbar = $true; $f.Width = 460; $f.Height = 330
  $f.StartPosition = 'CenterScreen'; $f.TopMost = $true; $f.WindowState = 'Normal'
  $f.FormBorderStyle = 'FixedDialog'; $f.MaximizeBox = $false
  $labels = @('Название', 'Сайт', 'Логин', 'Пароль')
  $fields = @()
  for ($i = 0; $i -lt 4; $i++) {
    $label = New-Object System.Windows.Forms.Label
    $label.Text = $labels[$i]; $label.Left = 15; $label.Top = 20 + 48 * $i; $label.Width = 90
    $box = New-Object System.Windows.Forms.TextBox
    $box.Left = 110; $box.Top = 16 + 48 * $i; $box.Width = 310
    if ($i -ge 2) { $box.UseSystemPasswordChar = $true }
    $f.Controls.Add($label); $f.Controls.Add($box); $fields += $box
  }
  $fields[0].Text = [string]$meta.name; $fields[1].Text = [string]$meta.site
  if ($meta.name) { $fields[0].ReadOnly = $true }
  $ok = New-Object System.Windows.Forms.Button
  $ok.Text = 'Сохранить'; $ok.Left = 235; $ok.Top = 220; $ok.Width = 85
  $ok.Add_Click({
    if ([string]::IsNullOrWhiteSpace($fields[0].Text) -or [string]::IsNullOrEmpty($fields[3].Text)) { return }
    $f.DialogResult = [System.Windows.Forms.DialogResult]::OK; $f.Close()
  })
  $cancel = New-Object System.Windows.Forms.Button
  $cancel.Text = 'Отмена'; $cancel.Left = 335; $cancel.Top = 220; $cancel.Width = 85
  $cancel.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
  $f.Controls.Add($ok); $f.Controls.Add($cancel); $f.AcceptButton = $ok; $f.CancelButton = $cancel
  # Explicit placement after layout: the cursor's monitor, clamped within its usable work area.
  $topTimer = New-Object System.Windows.Forms.Timer
  $topTimer.Interval = 8000
  $topTimer.Add_Tick({ $f.TopMost = $false; $topTimer.Stop() })
  $f.Add_Shown({
    $area = [System.Windows.Forms.Screen]::FromPoint([System.Windows.Forms.Cursor]::Position).WorkingArea
    $f.WindowState = 'Normal'
    $px = $area.X + [Math]::Max(0, [int](($area.Width - $f.Width) / 2))
    $py = $area.Y + [Math]::Max(0, [int](($area.Height - $f.Height) / 2))
    $f.Location = New-Object System.Drawing.Point -ArgumentList $px,$py
    $f.TopMost = $true; $f.ShowInTaskbar = $true; $f.Activate(); $f.BringToFront()
    $focused = [OrchestraVaultWindow]::Raise($f.Handle)
    $topTimer.Start()
    # Fixed allowlisted diagnostic only. Never names, sites or textbox values.
    $status = @{handle=$f.Handle.ToInt64();visible=[OrchestraVaultWindow]::IsWindowVisible($f.Handle);foreground=$focused;x=$f.Bounds.X;y=$f.Bounds.Y;width=$f.Bounds.Width;height=$f.Bounds.Height} | ConvertTo-Json -Compress
    [Console]::Out.WriteLine('ORCHESTRA_VAULT_SHOWN ' + $status); [Console]::Out.Flush()
  })
  if ($f.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) { $topTimer.Dispose(); $f.Dispose(); exit 0 }
  $data = [System.Text.Encoding]::UTF8.GetBytes((@{login=$fields[2].Text;password=$fields[3].Text} | ConvertTo-Json -Compress))
  try {
    $sealed = [System.Security.Cryptography.ProtectedData]::Protect($data, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
    @{name=$fields[0].Text;site=$fields[1].Text;blob=[Convert]::ToBase64String($sealed);backend='windows-dpapi-user-v1'} | ConvertTo-Json -Compress
  } finally { [Array]::Clear($data, 0, $data.Length); $fields[2].Clear(); $fields[3].Clear(); $topTimer.Dispose(); $f.Dispose() }
} catch { [Console]::Error.Write('Vault secure input failed'); exit 1 }
`

export function collector(platform = process.platform, options: { launch?: typeof spawn; timeoutMs?: number; startupMs?: number } = {}): Collector {
  return { async collect(existing, signal, onReady) {
    if (signal?.aborted) return undefined
    if (platform !== "win32") throw new Error("Vault: encrypted OS backend unavailable. No plaintext fallback. Windows DPAPI is required in this first version.")
    return new Promise((resolve, reject) => {
      // Async child only. A modal WinForms loop never runs in the TUI event loop.
      const root = process.env.SystemRoot || "C:\\Windows"
      const child = (options.launch ?? spawn)(`${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`, ["-NoLogo", "-NoProfile", "-NonInteractive", "-STA", "-EncodedCommand", Buffer.from(SCRIPT, "utf16le").toString("base64")], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true })
      let output = ""
      let settled = false
      let ready = false
      const cleanup = () => { clearTimeout(timer); clearTimeout(startupTimer); signal?.removeEventListener("abort", cancel) }
      const stop = () => { try { child.kill() } catch {} }
      const fail = (message = "Vault secure input failed; no entry saved.") => {
        if (settled) return
        settled = true; output = ""; cleanup(); stop(); reject(new Error(message))
      }
      const cancel = () => {
        if (settled) return
        settled = true; output = ""; cleanup(); stop(); resolve(undefined)
      }
      const timer = setTimeout(() => fail("Vault secure input timed out; no entry saved."), options.timeoutMs ?? 120_000)
      const startupTimer = setTimeout(() => fail("Vault secure input window did not open; no entry saved."), options.startupMs ?? 30_000)
      signal?.addEventListener("abort", cancel, { once: true })
      if (signal?.aborted) { cancel(); return }
      child.on("error", () => fail())
      child.stdout!.setEncoding("utf8")
      child.stdout!.on("data", (chunk: string) => {
        if (settled) return
        output += chunk
        if (!ready && output.startsWith("ORCHESTRA_VAULT_SHOWN ")) {
          const end = output.indexOf("\n")
          if (end >= 0) {
            let status: unknown
            try { status = JSON.parse(output.slice("ORCHESTRA_VAULT_SHOWN ".length, end).trim()) } catch { fail(); return }
            const v = status as Record<string, unknown> | null
            if (!v || Object.keys(v).some((key) => !["handle", "visible", "foreground", "x", "y", "width", "height"].includes(key)) ||
              ![v.handle, v.x, v.y, v.width, v.height].every((n) => typeof n === "number" && Number.isSafeInteger(n)) ||
              Number(v.handle) <= 0 || Number(v.width) < 1 || Number(v.width) > 20000 || Number(v.height) < 1 || Number(v.height) > 20000 ||
              typeof v.visible !== "boolean" || typeof v.foreground !== "boolean") { fail(); return }
            ready = true; output = output.slice(end + 1); clearTimeout(startupTimer)
            onReady?.(v as unknown as WindowStatus)
          }
        }
        if (output.length > 65536) fail()
      })
      // Native stderr, exception details and supplied fields never leave this process.
      child.stderr!.resume()
      child.stdin!.on("error", () => undefined)
      child.stdin!.end(JSON.stringify(existing ?? {}))
      child.on("close", (code) => {
        if (settled) return
        if (code !== 0) return fail()
        if (!output.trim()) { settled = true; cleanup(); return resolve(undefined) }
        try {
          const value = JSON.parse(output.replace(/^\uFEFF/, ""))
          output = ""
          if (typeof value.name !== "string" || typeof value.site !== "string" || typeof value.blob !== "string" || value.backend !== "windows-dpapi-user-v1" || !/^[A-Za-z0-9+/]+={0,2}$/.test(value.blob)) return fail()
          settled = true; cleanup()
          resolve({ name: value.name, site: value.site, blob: value.blob, backend: value.backend })
        } catch { fail() }
      })
    })
  } }
}
