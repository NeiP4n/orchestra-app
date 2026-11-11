import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { spawn } from "node:child_process"
import { tmpdir } from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { DesktopIsolation } from "@orchestra/core/desktop-isolation"
import { McpCatalog } from "@orchestra/core/mcp/catalog"
import { McpAcquire } from "@orchestra/core/mcp/acquire"
import { McpSelect } from "@orchestra/core/mcp/select"
import { ShellTool } from "@orchestra/core/tool/plugin/shell"
import type { KV } from "@orchestra/core/kv"
import { check, dedup } from "@orchestra/core/tool/idempotency"

const FUTURE = "2999-01-01T00:00:00Z"

const envWith = (patch: Record<string, string>): NodeJS.ProcessEnv =>
  ({ ...process.env, ...patch }) as NodeJS.ProcessEnv

const optInEnv = (allowlist = "notepad,zen-browser,agent-desktop,playwright"): NodeJS.ProcessEnv =>
  envWith({
    ORCHESTRA_DESKTOP_CAPTURE: "on",
    ORCHESTRA_DESKTOP_REAL_SCREEN: "on",
    ORCHESTRA_DESKTOP_REAL_SCREEN_ALLOWLIST: allowlist,
    ORCHESTRA_DESKTOP_REAL_SCREEN_UNTIL: FUTURE,
  })

const withEnv = async <T>(patch: Record<string, string | undefined>, run: () => T | Promise<T>): Promise<T> => {
  const prev: Record<string, string | undefined> = {}
  for (const key of Object.keys(patch)) {
    prev[key] = process.env[key]
    if (patch[key] === undefined) delete process.env[key]
    else process.env[key] = patch[key]
  }
  try {
    return await run()
  } finally {
    for (const key of Object.keys(patch)) {
      if (prev[key] === undefined) delete process.env[key]
      else process.env[key] = prev[key]
    }
  }
}

describe("B7 virtual display", () => {
  test("capture is off by default; on/1/true/yes/enabled allow the virtual display only", () => {
    expect(DesktopIsolation.isDesktopCaptureEnabled(envWith({ ORCHESTRA_DESKTOP_CAPTURE: "on" }))).toBe(true)
    expect(DesktopIsolation.isDesktopCaptureEnabled(envWith({ ORCHESTRA_DESKTOP_CAPTURE: "1" }))).toBe(true)
    expect(DesktopIsolation.isDesktopCaptureEnabled(envWith({ ORCHESTRA_DESKTOP_CAPTURE: "true" }))).toBe(true)
    expect(DesktopIsolation.isDesktopCaptureEnabled(envWith({ ORCHESTRA_DESKTOP_CAPTURE: "yes" }))).toBe(true)
    expect(DesktopIsolation.isDesktopCaptureEnabled(envWith({ ORCHESTRA_DESKTOP_CAPTURE: "off" }))).toBe(false)
    expect(DesktopIsolation.isDesktopCaptureEnabled(envWith({}))).toBe(false)
  })

  test("the virtual display defaults to :99 and rejects garbage", () => {
    expect(DesktopIsolation.virtualDisplay(envWith({}))).toBe(":99")
    expect(DesktopIsolation.virtualDisplay(envWith({ ORCHESTRA_VIRTUAL_DISPLAY: ":100" }))).toBe(":100")
    expect(DesktopIsolation.virtualDisplay(envWith({ ORCHESTRA_VIRTUAL_DISPLAY: "garbage" }))).toBe(":99")
    expect(DesktopIsolation.agentDisplayEnv(envWith({}))).toEqual({ DISPLAY: ":99" })
    expect(DesktopIsolation.agentDisplayEnv(envWith({ ORCHESTRA_VIRTUAL_DISPLAY: ":100" }))).toEqual({
      DISPLAY: ":100",
    })
  })

  test("Xvfb command and socket for a display", () => {
    expect(DesktopIsolation.xvfbCommand(":99")).toEqual({
      command: "Xvfb",
      args: [":99", "-screen", "0", "1280x800x24", "-nolisten", "tcp"],
    })
    expect(DesktopIsolation.virtualDisplaySocket(":99")).toBe("/tmp/.X11-unix/X99")
    expect(DesktopIsolation.virtualDisplaySocket(":100.0")).toBe("/tmp/.X11-unix/X100")
    expect(DesktopIsolation.virtualDisplaySocket("garbage")).toBeUndefined()
    expect(DesktopIsolation.isVirtualDisplayAlive(":99", () => true)).toBe(true)
    expect(DesktopIsolation.isVirtualDisplayAlive(":99", () => false)).toBe(false)
    expect(DesktopIsolation.isVirtualDisplayAlive("garbage", () => true)).toBe(false)
  })

  test("window manager command: openbox with DISPLAY, no arguments", () => {
    expect(DesktopIsolation.windowManagerCommand(":99")).toEqual({
      command: "openbox",
      args: [],
      env: { DISPLAY: ":99" },
    })
    expect(DesktopIsolation.windowManagerCommand(":100")).toEqual({
      command: "openbox",
      args: [],
      env: { DISPLAY: ":100" },
    })
  })
})

// A display socket faked with an empty file: isVirtualDisplayAlive only
// checks the socket exists, so ensureVirtualDisplay treats the display as
// "Xvfb is up" and goes straight to the window manager — no real X needed.
const fakeDisplaySocket = (display: string): string => {
  const dir = "/tmp/.X11-unix"
  mkdirSync(dir, { recursive: true })
  const socket = path.join(dir, `X${display.slice(1)}`)
  writeFileSync(socket, "", { flag: "wx", mode: 0o600 })
  return socket
}

const removeFakeSocket = (socket: string): void => {
  try {
    unlinkSync(socket)
  } catch {}
}

const isProcessAlive = (pid: number | undefined): boolean => {
  if (pid === undefined) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const waitForDeath = async (pid: number | undefined, timeoutMs = 5_000): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return !isProcessAlive(pid)
}

/** Inject real cross-platform JS child processes. No shell/PATH override or real desktop/Xvfb is used. */
const withOpenboxOnPath = async (
  script: string | undefined,
  run: (spawnFn: DesktopIsolation.VirtualDisplaySpawnFn) => Promise<void>,
): Promise<void> => {
  const children: ReturnType<typeof spawn>[] = []
  const spawnFn: DesktopIsolation.VirtualDisplaySpawnFn = (command, args, options) => {
    expect(["openbox", "Xvfb"]).toContain(command)
    if (command === "openbox" && script === undefined) throw new Error("openbox fixture not installed")
    const source =
      command === "Xvfb"
        ? `require('node:fs').writeFileSync(${JSON.stringify(path.join("/tmp/.X11-unix", `X${args[0]!.slice(1)}`))}, ''); setInterval(()=>{},1000)`
        : script!
    const child = spawn(process.execPath, ["-e", source], {
      env: { ...process.env, ...options?.env },
      stdio: ["ignore", "pipe", "pipe"],
    })
    children.push(child)
    return child
  }
  try {
    await run(spawnFn)
  } finally {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill()
      if (child.exitCode === null && child.signalCode === null)
        await new Promise<void>((resolve) => child.once("exit", () => resolve()))
    }
  }
}

describe("B7 virtual display window manager", () => {
  test("a bare Xvfb socket is not a ready display: ensure starts openbox on it, stop kills it", async () => {
    const display = ":97"
    const socket = fakeDisplaySocket(display)
    const recordPath = path.join(tmpdir(), `b7-wm-display-${process.pid}.txt`)
    // The stub records the DISPLAY it was given, then sleeps so the test can
    // watch it live; `exec` keeps the spawned pid.
    const stub = `require("node:fs").writeFileSync(${JSON.stringify(recordPath)}, process.env.DISPLAY); setInterval(()=>{},1000)`
    try {
      await withOpenboxOnPath(stub, async (spawnFn) => {
        const status = await DesktopIsolation.ensureVirtualDisplay(display, 5000, spawnFn)
        expect(status.display).toBe(display)
        expect(status.started).toBe(false)
        if (status.windowManagerPid === undefined) throw new Error("expected a window manager pid")
        expect(status.windowManagerPid).toBeGreaterThan(0)
        expect(isProcessAlive(status.windowManagerPid)).toBe(true)
        expect(readFileSync(recordPath, "utf8").trim()).toBe(display)
        // A second ensure reuses the running manager instead of starting another.
        const again = await DesktopIsolation.ensureVirtualDisplay(display, 5000, spawnFn)
        expect(again.windowManagerPid).toBe(status.windowManagerPid)
        DesktopIsolation.stopVirtualDisplay(display)
        expect(await waitForDeath(status.windowManagerPid)).toBe(true)
      })
    } finally {
      try {
        DesktopIsolation.stopVirtualDisplay(display)
      } catch {}
      removeFakeSocket(socket)
      try {
        unlinkSync(recordPath)
      } catch {}
    }
  }, 30_000)

  test("without openbox ensure fails loudly and names the install", async () => {
    const display = ":96"
    const socket = fakeDisplaySocket(display)
    try {
      await withOpenboxOnPath(undefined, async (spawnFn) => {
        let message = ""
        try {
          await DesktopIsolation.ensureVirtualDisplay(display, 5000, spawnFn)
        } catch (error) {
          message = error instanceof Error ? error.message : String(error)
        }
        expect(message).toContain("openbox")
        expect(message).toContain("Install openbox")
        expect(message).toContain("native_window_unproven")
      })
    } finally {
      removeFakeSocket(socket)
    }
  }, 30_000)

  test("a window manager already running on the display counts as ready", async () => {
    const display = ":95"
    const socket = fakeDisplaySocket(display)
    // The real openbox message, verified live 2026-11-07 (a second openbox
    // on a display that already has one prints this and exits 0) — on
    // STDOUT, not stderr: the first version of this test stubbed it to
    // stderr and passed while the live check failed. Both streams are
    // accepted, so a future openbox that moves the message still works.
    try {
      for (const redirect of ["stdout", "stderr"]) {
        const stub = `process.${redirect}.write("Openbox-Message: A window manager is already running on screen 0"); process.exit(0)`
        await withOpenboxOnPath(stub, async (spawnFn) => {
          const status = await DesktopIsolation.ensureVirtualDisplay(display, 5000, spawnFn)
          expect(status.display).toBe(display)
          expect(status.started).toBe(false)
          expect(status.windowManagerPid).toBeUndefined()
          expect(status.windowManagerForeign).toBe(true)
        })
      }
    } finally {
      removeFakeSocket(socket)
    }
  }, 30_000)

  test("a stale socket is recovered: openbox cannot connect once, Xvfb restarts and the retry succeeds", async () => {
    const display = ":93"
    const socket = fakeDisplaySocket(display)
    const countPath = path.join(tmpdir(), `b7-wm-count-${process.pid}.txt`)
    // First openbox call fails like a real one on a dead display (verified
    // live 2026-11-07: "Failed to open the display", exit 1) and removes
    // the stale socket, as a dying X server would; later calls stay up.
    const stub = `const fs=require('node:fs'); let n=0; try{n=Number(fs.readFileSync(${JSON.stringify(countPath)},'utf8'))}catch{};n++;fs.writeFileSync(${JSON.stringify(countPath)},String(n));if(n===1){fs.unlinkSync(${JSON.stringify(socket)});console.log('Openbox-Message: Failed to open the display from the DISPLAY environment variable.');process.exit(1)};setInterval(()=>{},1000)`
    try {
      await withOpenboxOnPath(stub, async (spawnFn) => {
        const status = await DesktopIsolation.ensureVirtualDisplay(display, 5000, spawnFn)
        expect(status.display).toBe(display)
        expect(status.started).toBe(true)
        if (status.windowManagerPid === undefined) throw new Error("expected a window manager pid")
        expect(status.windowManagerPid).toBeGreaterThan(0)
        expect(readFileSync(countPath, "utf8").trim()).toBe("2")
        expect(DesktopIsolation.isVirtualDisplayAlive(display)).toBe(true)
      })
    } finally {
      try {
        DesktopIsolation.stopVirtualDisplay(display)
      } catch {}
      removeFakeSocket(socket)
      try {
        unlinkSync(countPath)
      } catch {}
    }
  }, 30_000)

  test("a window manager that exits at once fails loudly", async () => {
    const display = ":94"
    const socket = fakeDisplaySocket(display)
    const stub = `console.error("openbox: cannot open display " + process.env.DISPLAY); process.exit(1)`
    try {
      await withOpenboxOnPath(stub, async (spawnFn) => {
        let message = ""
        try {
          await DesktopIsolation.ensureVirtualDisplay(display, 5000, spawnFn)
        } catch (error) {
          message = error instanceof Error ? error.message : String(error)
        }
        expect(message).toContain("openbox")
        expect(message).toContain("exited with code 1")
      })
    } finally {
      removeFakeSocket(socket)
    }
  }, 30_000)
})

describe("B7 real-screen opt-in", () => {
  test("every missing piece denies with a plain-language reason", () => {
    expect(DesktopIsolation.realScreenDecision(envWith({})).allowed).toBe(false)
    expect(DesktopIsolation.realScreenDecision(envWith({})).reason).toContain("ORCHESTRA_DESKTOP_CAPTURE")
    const captureOnly = DesktopIsolation.realScreenDecision(envWith({ ORCHESTRA_DESKTOP_CAPTURE: "on" }))
    expect(captureOnly.allowed).toBe(false)
    expect(captureOnly.reason).toContain("ORCHESTRA_DESKTOP_REAL_SCREEN=on")
    const noAllowlist = DesktopIsolation.realScreenDecision(
      envWith({
        ORCHESTRA_DESKTOP_CAPTURE: "on",
        ORCHESTRA_DESKTOP_REAL_SCREEN: "on",
        ORCHESTRA_DESKTOP_REAL_SCREEN_UNTIL: FUTURE,
      }),
    )
    expect(noAllowlist.allowed).toBe(false)
    expect(noAllowlist.reason).toContain("ALLOWLIST is empty")
    const noExpiry = DesktopIsolation.realScreenDecision(
      envWith({
        ORCHESTRA_DESKTOP_CAPTURE: "on",
        ORCHESTRA_DESKTOP_REAL_SCREEN: "on",
        ORCHESTRA_DESKTOP_REAL_SCREEN_ALLOWLIST: "notepad",
      }),
    )
    expect(noExpiry.allowed).toBe(false)
    expect(noExpiry.reason).toContain("ORCHESTRA_DESKTOP_REAL_SCREEN_UNTIL")
    const expired = DesktopIsolation.realScreenDecision(optInEnv(), undefined, Date.parse("2999-06-01T00:00:00Z"))
    expect(expired.allowed).toBe(false)
    expect(expired.reason).toContain("expired")
  })

  test("the allowlist must name the app; a basename match counts", () => {
    const env = optInEnv()
    expect(DesktopIsolation.realScreenDecision(env, "calc").allowed).toBe(false)
    expect(DesktopIsolation.realScreenDecision(env, "calc").reason).toContain(
      "not in ORCHESTRA_DESKTOP_REAL_SCREEN_ALLOWLIST",
    )
    expect(DesktopIsolation.realScreenDecision(env, "notepad").allowed).toBe(true)
    expect(DesktopIsolation.realScreenDecision(env, "C:\\Windows\\notepad.exe").allowed).toBe(true)
    expect(DesktopIsolation.realScreenDecision(env).allowed).toBe(true)
    expect(DesktopIsolation.isRealScreenAllowed(env, "zen-browser")).toBe(true)
    expect(DesktopIsolation.realScreenDenial(env, "zen-browser")).toBeUndefined()
    expect(DesktopIsolation.realScreenDenial(env, "calc")).toContain("not in ORCHESTRA_DESKTOP_REAL_SCREEN_ALLOWLIST")
  })
})

describe("B7 shell escapes", () => {
  test("screen, mouse, and clipboard escapes are refused; plain commands pass", () => {
    const env = envWith({ ORCHESTRA_DESKTOP_CAPTURE: "on" })
    for (const command of [
      "xdotool mousemove 10 10",
      "ydotool type hello",
      "screencapture -x shot.png",
      "grim shot.png",
      "scrot shot.png",
      "xwd -root -out shot.xwd",
      "import -window root shot.png",
      "gnome-screenshot",
      "xclip -selection clipboard -o",
      "xsel -b -o",
      "wl-copy < file",
      "pbpaste",
      "powershell -Command \"[System.Windows.Forms.SendKeys]::SendWait('hello')\"",
      'powershell -Command "[OcDesk]::SetCursorPos(10, 10)"',
      "DISPLAY=:0 xdg-open https://example.com",
      "DISPLAY=$DISPLAY grim shot.png",
      // G2-9: macOS GUI control and scripted GUI automation.
      "osascript -e 'tell application \"System Events\" to click at {10, 10}'",
      "cliclick c:100,100",
      'python3 -c "import pyautogui; pyautogui.click(10, 10)"',
      'python3 -c "import pynput; from pynput.mouse import Controller"',
      'python3 -c "import pywinauto; pywinauto.mouse.click()"',
      // G2-9: X window tools and Android control.
      "xprop -root",
      "xwininfo -root -tree",
      "wmctrl -l",
      "adb shell screencap -p /sdcard/shot.png",
      "wtype hello",
      // G2-9: a bare ImageMagick import screenshots the whole screen.
      "import shot.png",
      "sudo import shot.png",
      "magick import shot.png",
      "ls; import shot.png",
    ]) {
      expect(DesktopIsolation.forbiddenDesktopEscape(command, env)).toContain("Refusing")
    }
    expect(DesktopIsolation.forbiddenDesktopEscape("ls -la", env)).toBeUndefined()
    expect(DesktopIsolation.forbiddenDesktopEscape("git status", env)).toBeUndefined()
    expect(DesktopIsolation.forbiddenDesktopEscape("bun test", env)).toBeUndefined()
    expect(DesktopIsolation.forbiddenDesktopEscape("DISPLAY=:99 echo hi", env)).toBeUndefined()
    // G2-9: a Python import is not ImageMagick's `import`, and the word
    // `import` outside a command start is not a screenshot.
    expect(DesktopIsolation.forbiddenDesktopEscape('python3 -c "import os; print(1)"', env)).toBeUndefined()
    expect(DesktopIsolation.forbiddenDesktopEscape('python3 -c "from os import path"', env)).toBeUndefined()
    expect(DesktopIsolation.forbiddenDesktopEscape("echo import", env)).toBeUndefined()
  })

  test("a valid real-screen opt-in lets the escape through", () => {
    expect(DesktopIsolation.forbiddenDesktopEscape("xdotool key ctrl+s", optInEnv())).toBeUndefined()
    expect(DesktopIsolation.forbiddenDesktopEscape("DISPLAY=:0 echo hi", optInEnv())).toBeUndefined()
  })

  test("forbiddenCommand wires the escape gate next to the secret-file gate", () => {
    expect(ShellTool.forbiddenCommand("xdotool mousemove 10 10")).toContain("Refusing")
    expect(ShellTool.forbiddenCommand("cat .env")).toContain("protected file")
    expect(ShellTool.forbiddenCommand("ls -la")).toBeUndefined()
  })
})

describe("G2-9 desktop platform gate", () => {
  test("Linux always passes: the agent works on its virtual display", () => {
    expect(DesktopIsolation.desktopPlatformDenial(envWith({}), "linux")).toBeUndefined()
    expect(
      DesktopIsolation.desktopPlatformDenial(envWith({ ORCHESTRA_DESKTOP_CAPTURE: "on" }), "linux"),
    ).toBeUndefined()
    expect(DesktopIsolation.desktopPlatformDenial(optInEnv(), "linux")).toBeUndefined()
  })

  test("macOS and Windows refuse honestly: no virtual display there", () => {
    const captureOnly = envWith({ ORCHESTRA_DESKTOP_CAPTURE: "on" })
    for (const platform of ["darwin", "win32"] as const) {
      const denied = DesktopIsolation.desktopPlatformDenial(captureOnly, platform)
      expect(denied).toContain("no virtual display")
      expect(denied).toContain("refuse to run")
      expect(denied).toContain("ORCHESTRA_DESKTOP_REAL_SCREEN")
    }
    expect(DesktopIsolation.desktopPlatformDenial(captureOnly, "darwin")).toContain("macOS")
    expect(DesktopIsolation.desktopPlatformDenial(captureOnly, "win32")).toContain("Windows")
    // Without capture at all the refusal still names the missing virtual display.
    expect(DesktopIsolation.desktopPlatformDenial(envWith({}), "darwin")).toContain("no virtual display")
  })

  test("a valid real-screen opt-in lets macOS/Windows through (operator's explicit choice)", () => {
    expect(DesktopIsolation.desktopPlatformDenial(optInEnv(), "darwin")).toBeUndefined()
    expect(DesktopIsolation.desktopPlatformDenial(optInEnv(), "win32")).toBeUndefined()
  })
})

describe("B7 MCP real-screen servers", () => {
  test("only playwright and agent-desktop are marked real-screen", () => {
    expect(McpCatalog.isRealScreenServer("playwright")).toBe(true)
    expect(McpCatalog.isRealScreenServer("agent-desktop")).toBe(true)
    expect(McpCatalog.isRealScreenServer("context7")).toBe(false)
    expect(McpCatalog.isRealScreenServer("serena")).toBe(false)
    expect(McpCatalog.all.find((entry) => entry.id === "playwright")).toBeUndefined()
    expect(McpCatalog.all.find((entry) => entry.id === "agent-desktop")).toBeUndefined()
  })

  test("retired real-screen servers are not rediscovered by ranking; safety classification remains", async () => {
    // Catalog removal must not remove the independent safety classification
    // used to guard manually configured real-screen servers.
    await withEnv({ ORCHESTRA_DESKTOP_CAPTURE: undefined, ORCHESTRA_DESKTOP_REAL_SCREEN: undefined }, () => {
      expect(McpSelect.rank("playwright")).toEqual([])
      expect(McpSelect.rank("agent-desktop").some((match) => match.entry.id === "agent-desktop")).toBe(false)
    })
  })

  test("acquire cannot reinstall a retired real-screen server, even with a valid opt-in", async () => {
    const calls: string[] = []
    const access: McpAcquire.Access = {
      servers: () => Effect.succeed([]),
      add: () => Effect.sync(() => void calls.push("add")),
      connect: () => Effect.succeed(undefined),
      tools: () => Effect.succeed([]),
    }
    await withEnv(
      { ORCHESTRA_MCP: "1", ORCHESTRA_DESKTOP_CAPTURE: undefined, ORCHESTRA_DESKTOP_REAL_SCREEN: undefined },
      async () => {
        const refused = await Effect.runPromise(McpAcquire.ensure(access, "agent-desktop"))
        expect(refused.action).toBe("none")
        expect(refused.state).toBe("unavailable")
        expect(refused.detail).toContain("No MCP catalog entry")
        expect(calls).toEqual([])
      },
    )
    await withEnv(
      {
        ORCHESTRA_MCP: "1",
        ORCHESTRA_DESKTOP_CAPTURE: "on",
        ORCHESTRA_DESKTOP_REAL_SCREEN: "on",
        ORCHESTRA_DESKTOP_REAL_SCREEN_ALLOWLIST: "agent-desktop",
        ORCHESTRA_DESKTOP_REAL_SCREEN_UNTIL: FUTURE,
      },
      async () => {
        const ensured = await Effect.runPromise(McpAcquire.ensure(access, "agent-desktop"))
        expect(ensured.action).toBe("none")
        expect(ensured.state).toBe("unavailable")
        expect(calls).toEqual([])
      },
    )
  })
})

describe("B7 dedup across re-entry", () => {
  const fakeKV = (store: Map<string, KV.Value>): KV.Interface => ({
    get: (key) => Effect.succeed(store.get(key)),
    set: (key, value) => Effect.sync(() => void store.set(key, value)),
    remove: (key) => Effect.sync(() => void store.delete(key)),
    atomicUpdate: (key, update) =>
      Effect.sync(() => {
        const next = update(store.get(key))
        if (next === undefined) store.delete(key)
        else store.set(key, next)
        return next
      }),
    scan: (options) =>
      Effect.sync(() => ({
        entries: [...store.entries()]
          .filter(([key]) => key.startsWith(options.prefix))
          .map(([key, value]) => ({ key, value })),
      })),
  })

  test("after a re-entry (a fresh KV service over the same store) the link still does not open again", async () => {
    const store = new Map<string, KV.Value>()
    const input = { sessionID: "ses-1", action: "desktop_open", target: "https://example.com" }
    let runs = 0
    const open = (kv: KV.Interface) =>
      dedup(
        kv,
        input,
        Effect.sync(() => `opened (#${(runs += 1)})`),
      )
    await Effect.runPromise(open(fakeKV(store)))
    expect(runs).toBe(1)
    // The process restarts: a new KV service, the same durable store.
    const reentered = fakeKV(store)
    expect(await Effect.runPromise(check(reentered, input))).toMatchObject({ result: "opened (#1)" })
    const again = await Effect.runPromise(open(reentered))
    expect(again).toEqual({ duplicate: true, result: "opened (#1)" })
    expect(runs).toBe(1)
  })
})
