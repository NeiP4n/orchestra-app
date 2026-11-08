export * as WindowCapture from "./window-capture.js"

// Real Chrome UI inside the pane (Windows only): a normal headed Chrome window is kept off-screen and out of
// the taskbar, a long-lived PowerShell helper copies its pixels with PrintWindow, and the operator's mouse
// and keys are posted to it as window messages. The helper is plain PowerShell with inline C#, so nothing
// is installed. It talks over stdin (one command per line) and stdout (status and frame lines).
//
// This path could not be tested on a Windows machine. Headless streaming stays the fallback.

/** Flags that stop Chrome from pausing a window the operator cannot see on screen. */
export const KEEP_PAINTING_FLAGS = [
  "--disable-features=CalculateNativeWinOcclusion",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
  "--disable-background-timer-throttling",
]

export const OFFSCREEN = { x: -32000, y: -32000 }

export interface Size {
  readonly width: number
  readonly height: number
}

export type Line =
  | { type: "frame"; width: number; height: number; data: string }
  | { type: "status"; ok: boolean; text: string }
  | { type: "other"; text: string }

/** One line the helper printed. Frames are `F <width> <height> <base64 jpeg>`, status is `S ok|err <text>`. */
export function parseLine(line: string): Line {
  const text = line.trim()
  const frame = /^F (\d+) (\d+) ([A-Za-z0-9+/=]+)$/.exec(text)
  if (frame) return { type: "frame", width: Number(frame[1]), height: Number(frame[2]), data: frame[3]! }
  const status = /^S (ok|err)\s*(.*)$/.exec(text)
  if (status) return { type: "status", ok: status[1] === "ok", text: status[2] ?? "" }
  return { type: "other", text }
}

export const attachCommand = (pid: number, size: Size) =>
  `attach ${Math.trunc(pid)} ${OFFSCREEN.x} ${OFFSCREEN.y} ${Math.round(size.width)} ${Math.round(size.height)}`

export const sizeCommand = (size: Size) => `size ${Math.round(size.width)} ${Math.round(size.height)}`

export type Mouse =
  | { kind: "down" | "up"; x: number; y: number; button?: "left" | "middle" | "right" }
  | { kind: "move"; x: number; y: number }
  | { kind: "wheel"; x: number; y: number; deltaY: number }

export function mouseCommand(input: Mouse): string {
  const at = `${Math.round(input.x)} ${Math.round(input.y)}`
  if (input.kind === "move") return `mouse move ${at}`
  if (input.kind === "wheel") return `mouse ${input.deltaY < 0 ? "wheelup" : "wheeldown"} ${at}`
  const side = input.button === "right" ? "r" : "l"
  return `mouse ${side}${input.kind} ${at}`
}

/** Named keys the helper sends as virtual-key presses: name -> Windows virtual key code. */
export const VIRTUAL_KEYS: Record<string, number> = {
  return: 13,
  enter: 13,
  backspace: 8,
  tab: 9,
  escape: 27,
  delete: 46,
  up: 38,
  down: 40,
  left: 37,
  right: 39,
  home: 36,
  end: 35,
  pageup: 33,
  pagedown: 34,
}

/** Commands for one key press: named keys as key down and up, text as one character message per character. */
export function keyCommands(key: { name: string; sequence: string; ctrl?: boolean; meta?: boolean; option?: boolean }) {
  if (key.ctrl || key.meta || key.option) return []
  const vk = VIRTUAL_KEYS[key.name]
  if (vk !== undefined) return [`key ${vk} down`, `key ${vk} up`]
  const text = key.name === "space" ? " " : key.sequence
  if (!text || /^[\x00-\x1f\x7f]/.test(text) || text.startsWith("\x1b")) return []
  return Array.from(text, (character) => `char ${character.codePointAt(0)}`)
}

/** The helper: attaches to Chrome's window by process id, hides it from the taskbar, copies and drives it. */
export const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class Cap {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] struct POINT { public int X, Y; }
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] static extern int SetWindowLong(IntPtr h, int i, int v);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);

  static IntPtr hwnd = IntPtr.Zero;
  static int posX, posY;
  static ConcurrentQueue<string> queue = new ConcurrentQueue<string>();
  static ImageCodecInfo jpeg;
  static EncoderParameters quality;

  static IntPtr Find(uint pid) {
    IntPtr found = IntPtr.Zero;
    EnumWindows(delegate (IntPtr h, IntPtr l) {
      uint owner; GetWindowThreadProcessId(h, out owner);
      if (owner != pid) return true;
      StringBuilder cls = new StringBuilder(64); GetClassName(h, cls, 64);
      RECT r; GetWindowRect(h, out r);
      if (cls.ToString() == "Chrome_WidgetWin_1" && IsWindowVisible(h) && (r.R - r.L) > 100) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }

  static void Say(string line) { Console.Out.WriteLine(line); Console.Out.Flush(); }

  static void Attach(string[] a) {
    uint pid = uint.Parse(a[1]);
    posX = int.Parse(a[2]); posY = int.Parse(a[3]);
    int w = int.Parse(a[4]), h = int.Parse(a[5]);
    for (int i = 0; i < 100 && hwnd == IntPtr.Zero; i++) { hwnd = Find(pid); if (hwnd == IntPtr.Zero) Thread.Sleep(100); }
    if (hwnd == IntPtr.Zero) { Say("S err no Chrome window for that process"); return; }
    ShowWindow(hwnd, 0);
    int ex = GetWindowLong(hwnd, -20);
    ex = (ex | 0x80) & ~0x40000; // tool window, not an app window: no taskbar button, not in Alt-Tab
    SetWindowLong(hwnd, -20, ex);
    ShowWindow(hwnd, 4); // shown without taking focus
    SetWindowPos(hwnd, IntPtr.Zero, posX, posY, w, h, 0x14); // no activate, keep z-order
    Say("S ok attached");
  }

  static IntPtr Pack(int x, int y) { return (IntPtr)(((y & 0xFFFF) << 16) | (x & 0xFFFF)); }

  static void Mouse(string[] a) {
    if (hwnd == IntPtr.Zero) return;
    RECT r; GetWindowRect(hwnd, out r);
    POINT origin = new POINT(); ClientToScreen(hwnd, ref origin);
    int x = int.Parse(a[2]) - (origin.X - r.L), y = int.Parse(a[3]) - (origin.Y - r.T);
    switch (a[1]) {
      case "move": PostMessage(hwnd, 0x200, IntPtr.Zero, Pack(x, y)); break;
      case "ldown":
        // Chrome takes clicks as a person's: the window active and focused, the pointer on the spot first.
        PostMessage(hwnd, 0x86, (IntPtr)1, IntPtr.Zero); PostMessage(hwnd, 0x6, (IntPtr)1, IntPtr.Zero); PostMessage(hwnd, 0x7, IntPtr.Zero, IntPtr.Zero);
        PostMessage(hwnd, 0x200, IntPtr.Zero, Pack(x, y));
        PostMessage(hwnd, 0x201, (IntPtr)1, Pack(x, y)); break;
      case "lup": PostMessage(hwnd, 0x202, IntPtr.Zero, Pack(x, y)); break;
      case "rdown": PostMessage(hwnd, 0x204, (IntPtr)2, Pack(x, y)); break;
      case "rup": PostMessage(hwnd, 0x205, IntPtr.Zero, Pack(x, y)); break;
      case "wheelup": case "wheeldown": {
        int delta = a[1] == "wheelup" ? 120 : -120;
        PostMessage(hwnd, 0x20A, (IntPtr)((delta << 16) & unchecked((int)0xFFFF0000)), Pack(origin.X + x, origin.Y + y));
        break;
      }
    }
  }

  static void Key(string[] a) {
    if (hwnd == IntPtr.Zero) return;
    int vk = int.Parse(a[1]);
    if (a[2] == "down") PostMessage(hwnd, 0x100, (IntPtr)vk, (IntPtr)1);
    else PostMessage(hwnd, 0x101, (IntPtr)vk, unchecked((IntPtr)(int)0xC0000001));
  }

  static void Frame() {
    if (hwnd == IntPtr.Zero) return;
    RECT r; if (!GetWindowRect(hwnd, out r)) return;
    int w = r.R - r.L, h = r.B - r.T;
    if (w < 50 || h < 50) return;
    using (Bitmap bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb)) {
      using (Graphics g = Graphics.FromImage(bmp)) {
        IntPtr dc = g.GetHdc();
        try { PrintWindow(hwnd, dc, 2); } finally { g.ReleaseHdc(dc); }
      }
      using (MemoryStream ms = new MemoryStream()) {
        bmp.Save(ms, jpeg, quality);
        Say("F " + w + " " + h + " " + Convert.ToBase64String(ms.ToArray()));
      }
    }
  }

  public static void Run() {
    // Per-monitor aware (v2) like Chrome, so window sizes and the pointer use the same physical pixels on a scaled display.
    try { if (!SetProcessDpiAwarenessContext((IntPtr)(-4))) SetProcessDPIAware(); } catch { SetProcessDPIAware(); }
    foreach (ImageCodecInfo c in ImageCodecInfo.GetImageEncoders()) if (c.MimeType == "image/jpeg") jpeg = c;
    quality = new EncoderParameters(1);
    quality.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, 60L);
    Thread reader = new Thread(delegate () { string l; while ((l = Console.In.ReadLine()) != null) queue.Enqueue(l); queue.Enqueue("quit"); });
    reader.IsBackground = true; reader.Start();
    DateTime next = DateTime.MinValue;
    while (true) {
      string line;
      while (queue.TryDequeue(out line)) {
        string[] a = line.Split(' ');
        try {
          if (a[0] == "quit") return;
          else if (a[0] == "attach") Attach(a);
          else if (a[0] == "size" && hwnd != IntPtr.Zero) SetWindowPos(hwnd, IntPtr.Zero, posX, posY, int.Parse(a[1]), int.Parse(a[2]), 0x14);
          else if (a[0] == "mouse") Mouse(a);
          else if (a[0] == "key") Key(a);
          else if (a[0] == "char" && hwnd != IntPtr.Zero) PostMessage(hwnd, 0x102, (IntPtr)int.Parse(a[1]), (IntPtr)1);
        } catch (Exception e) { Say("S err " + e.Message.Replace('\n', ' ')); }
      }
      if (DateTime.UtcNow >= next) { try { Frame(); } catch (Exception e) { Say("S err " + e.Message.Replace('\n', ' ')); } next = DateTime.UtcNow.AddMilliseconds(120); }
      Thread.Sleep(15);
    }
  }
}
'@
[Cap]::Run()
`

export interface Controller {
  /** Frames (JPEG, base64) as the window changes; called with a new size after a resize. */
  readonly watch: (size: Size, onFrame: (frame: { data: string; width: number; height: number }) => void) => void
  readonly unwatch: () => void
  readonly mouse: (input: Mouse) => void
  readonly key: (key: Parameters<typeof keyCommands>[0]) => void
  readonly stop: () => void
}

export interface Process {
  readonly write: (line: string) => void
  readonly kill: () => void
  /** Registers the stdout line listener and the exit listener. */
  readonly onLine: (listener: (line: string) => void) => void
  readonly onExit: (listener: () => void) => void
}

/**
 * Starts the helper for Chrome's process `pid` and waits until it reports that it found and moved the window.
 * Rejects with the helper's own reason when it cannot (no window, PowerShell blocked, helper exited).
 */
export function start(spawn: () => Process, pid: number, size: Size, timeoutMs = 20_000): Promise<Controller> {
  const process = spawn()
  let listener: ((frame: { data: string; width: number; height: number }) => void) | undefined
  return new Promise((resolve, reject) => {
    let ready = false
    const fail = (message: string) => {
      process.kill()
      reject(new Error(message))
    }
    const timer = setTimeout(() => fail("The window capture helper did not attach in time."), timeoutMs)
    process.onExit(() => {
      clearTimeout(timer)
      if (!ready) reject(new Error("The window capture helper exited before it attached."))
    })
    process.onLine((raw) => {
      const line = parseLine(raw)
      if (line.type === "frame") return listener?.({ data: line.data, width: line.width, height: line.height })
      if (line.type !== "status") return
      if (!ready && line.ok) {
        ready = true
        clearTimeout(timer)
        resolve({
          watch: (next, onFrame) => {
            listener = onFrame
            process.write(sizeCommand(next))
          },
          unwatch: () => {
            listener = undefined
          },
          mouse: (input) => process.write(mouseCommand(input)),
          key: (key) => keyCommands(key).forEach((command) => process.write(command)),
          stop: () => {
            process.write("quit")
            process.kill()
          },
        })
      } else if (!ready) {
        clearTimeout(timer)
        fail(line.text || "The window capture helper could not attach.")
      }
    })
    process.write(attachCommand(pid, size))
  })
}
