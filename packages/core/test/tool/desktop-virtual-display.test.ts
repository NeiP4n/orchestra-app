import { describe, expect, test } from "bun:test"
import { execFileSync, execSync, spawn, type ChildProcess } from "node:child_process"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { DesktopIsolation } from "@orchestra/core/desktop-isolation"
import { DesktopTool } from "@orchestra/core/tool/plugin/desktop"
import { Tool } from "@orchestra/core/tool"
import { Session } from "@orchestra/core/session"
import { Agent } from "@orchestra/core/agent"
import { registerToolPlugin, toolIdentity } from "../lib/tool"
import { PluginTestLayer } from "../plugin/fixture"

// Live B7 regression test. It runs ONLY where a virtual display can exist:
// Xvfb + ffmpeg + python3/tkinter. It never touches the machine the tests
// run on as "the operator's screen": the host display here is itself an
// Xvfb (:98), and the agent display is another Xvfb (:99).
//
// The secret window (magenta, labelled SECRET) lives on the host display.
// The agent screenshot must show the agent's own display only: zero magenta
// pixels, and the green marker that lives on the virtual display must be
// visible. The control shot proves the secret was really drawn and that the
// grabber can see it — so a zero count is a pass, not a broken setup.

const HOST_DISPLAY = ":98"
const AGENT_DISPLAY = ":99"

const has = (command: string): boolean => {
  try {
    execSync(`command -v ${command}`, { stdio: "ignore" })
    return true
  } catch {
    return false
  }
}

const hasLiveTools =
  process.platform === "linux" && has("Xvfb") && has("ffmpeg") && has("python3") && has("openbox")
// ensureVirtualDisplay now requires openbox on the agent display (a bare
// Xvfb is never a ready display), so the live tests need it too.

const waitFor = async (check: () => boolean, timeoutMs = 10_000): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return true
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return check()
}

const DRAW_SCRIPT = `
import os, sys, tkinter as tk
display, color, label = sys.argv[1], sys.argv[2], sys.argv[3]
os.environ["DISPLAY"] = display
root = tk.Tk()
root.geometry("400x300+100+100")
root.configure(bg=color)
tk.Label(root, text=label, bg=color, fg="white", font=("Arial", 20)).pack(expand=True)
root.update()
import time
time.sleep(30)
`

const countPixels = (file: string, channel: "magenta" | "green"): number => {
  const script = `
from PIL import Image
import sys
im = Image.open(sys.argv[1]).convert("RGB")
px = im.load()
if sys.argv[2] == "magenta":
    print(sum(1 for x in range(im.size[0]) for y in range(im.size[1]) if px[x, y][0] > 200 and px[x, y][1] < 80 and px[x, y][2] > 200))
else:
    print(sum(1 for x in range(im.size[0]) for y in range(im.size[1]) if px[x, y][0] < 80 and px[x, y][1] > 200 and px[x, y][2] < 80))
`
  return Number(execFileSync("python3", ["-c", script, file, channel], { encoding: "utf8" }).trim())
}

describe("B7 virtual display (live Xvfb)", () => {
  test.skipIf(!hasLiveTools)("a secret window on the host display is invisible on the agent screenshot", async () => {
    const prevCapture = process.env.ORCHESTRA_DESKTOP_CAPTURE
    const prevDisplay = process.env.DISPLAY
    const prevVirtual = process.env.ORCHESTRA_VIRTUAL_DISPLAY
    process.env.ORCHESTRA_DESKTOP_CAPTURE = "on"
    process.env.ORCHESTRA_VIRTUAL_DISPLAY = AGENT_DISPLAY
    // The server process itself "sits" on the host display, like a real
    // user session would: the tool must ignore this DISPLAY, not use it.
    process.env.DISPLAY = HOST_DISPLAY
    const children: ChildProcess[] = []
    try {
      const agent = await DesktopIsolation.ensureVirtualDisplay(AGENT_DISPLAY)
      expect(agent.display).toBe(AGENT_DISPLAY)
      expect(DesktopIsolation.isVirtualDisplayAlive(AGENT_DISPLAY)).toBe(true)
      // ensureVirtualDisplay starts a window manager on the agent display:
      // without it agent-desktop cannot snapshot the display.
      expect(typeof agent.windowManagerPid).toBe("number")
      // The host display stays bare Xvfb on purpose: it stands in for the
      // operator's real screen, not an agent display — no window manager there.
      const host = spawn("Xvfb", [HOST_DISPLAY, "-screen", "0", "1280x800x24", "-nolisten", "tcp"], {
        detached: true,
        stdio: "ignore",
      })
      host.unref()
      children.push(host)
      expect(await waitFor(() => DesktopIsolation.isVirtualDisplayAlive(HOST_DISPLAY))).toBe(true)

      const scriptPath = path.join(tmpdir(), `b7-draw-${process.pid}.py`)
      await Bun.write(scriptPath, DRAW_SCRIPT)
      const secret = spawn("python3", [scriptPath, HOST_DISPLAY, "#FF00FF", "SECRET-HOST-WINDOW"], {
        env: { ...process.env, DISPLAY: HOST_DISPLAY },
        stdio: "ignore",
      })
      children.push(secret)
      const marker = spawn("python3", [scriptPath, AGENT_DISPLAY, "#00FF00", "AGENT-VIRTUAL"], {
        env: { ...process.env, DISPLAY: AGENT_DISPLAY },
        stdio: "ignore",
      })
      children.push(marker)
      await new Promise((resolve) => setTimeout(resolve, 1500))

      // Control: the host display really shows the secret, and the grabber sees it.
      const hostShot = path.join(tmpdir(), `b7-host-${process.pid}.jpg`)
      execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "x11grab", "-i", HOST_DISPLAY, "-frames:v", "1", hostShot])
      expect(existsSync(hostShot)).toBe(true)
      expect(countPixels(hostShot, "magenta")).toBeGreaterThan(10_000)

      // The agent screenshot, taken while the process DISPLAY points at the host.
      const toolHost = DesktopTool.makeHost()
      try {
        const shot = await DesktopTool.run(toolHost, { action: "screenshot", width: 640 }, undefined)
        if (typeof shot === "string") throw new Error("expected a screenshot")
        expect(shot.width).toBe(640)
        expect(countPixels(shot.file, "magenta")).toBe(0)
        expect(countPixels(shot.file, "green")).toBeGreaterThan(1_000)
      } finally {
        toolHost.close()
      }
    } finally {
      for (const child of children) {
        try {
          child.kill()
        } catch {}
      }
      if (prevCapture !== undefined) process.env.ORCHESTRA_DESKTOP_CAPTURE = prevCapture
      else delete process.env.ORCHESTRA_DESKTOP_CAPTURE
      if (prevDisplay !== undefined) process.env.DISPLAY = prevDisplay
      else delete process.env.DISPLAY
      if (prevVirtual !== undefined) process.env.ORCHESTRA_VIRTUAL_DISPLAY = prevVirtual
      else delete process.env.ORCHESTRA_VIRTUAL_DISPLAY
    }
  }, 60_000)

  test.skipIf(!hasLiveTools)("a link opens once across three calls, and not again after re-entry", async () => {
    const prevCapture = process.env.ORCHESTRA_DESKTOP_CAPTURE
    const prevVirtual = process.env.ORCHESTRA_VIRTUAL_DISPLAY
    process.env.ORCHESTRA_DESKTOP_CAPTURE = "on"
    process.env.ORCHESTRA_VIRTUAL_DISPLAY = AGENT_DISPLAY
    try {
      await DesktopIsolation.ensureVirtualDisplay(AGENT_DISPLAY)
      const sessionID = Session.ID.make("ses_b7_dedup")
      const program = Effect.scoped(
        Effect.gen(function* () {
          const tools = yield* Tool.Service
          yield* registerToolPlugin(DesktopTool.Plugin)
          const open = (id: string) =>
            Effect.gen(function* () {
              const snapshot = yield* tools.snapshot()
              return yield* snapshot.execute({
                call: { type: "tool-call", id, name: "desktop_open", input: { target: "https://example.com/b7-dedup" } },
                sessionID,
                ...toolIdentity,
                agent: Agent.ID.make("test-agent"),
              })
            })
          const first = yield* open("call-b7-1")
          const second = yield* open("call-b7-2")
          const third = yield* open("call-b7-3")
          // Re-entry: the plugin is registered again (a new perform closure,
          // as after a restart) and a fresh snapshot executes the open.
          // The durable KV record from the first open must still win.
          yield* registerToolPlugin(DesktopTool.Plugin)
          const reentered = yield* open("call-b7-4")
          return [first, second, third, reentered]
        }),
      ).pipe(Effect.provide(PluginTestLayer))
      const [first, second, third, reentered] = await Effect.runPromise(program)
      expect(JSON.stringify(first)).toContain("opened https://example.com/b7-dedup")
      expect(JSON.stringify(second)).toContain("already open")
      expect(JSON.stringify(third)).toContain("already open")
      expect(JSON.stringify(reentered)).toContain("already open")
    } finally {
      if (prevCapture !== undefined) process.env.ORCHESTRA_DESKTOP_CAPTURE = prevCapture
      else delete process.env.ORCHESTRA_DESKTOP_CAPTURE
      if (prevVirtual !== undefined) process.env.ORCHESTRA_VIRTUAL_DISPLAY = prevVirtual
      else delete process.env.ORCHESTRA_VIRTUAL_DISPLAY
    }
  }, 60_000)
})
