import { test, expect } from "bun:test"
import { execSync } from "node:child_process"
import { Effect, Cause } from "effect"
import { DesktopTool } from "@orchestra/core/tool/plugin/desktop"
import { Tool } from "@orchestra/core/tool"
import { Session } from "@orchestra/core/session"
import { Agent } from "@orchestra/core/agent"
import { registerToolPlugin, toolIdentity } from "../lib/tool"
import { PluginTestLayer } from "../plugin/fixture"

function runPs(script: string): string {
  const b64 = Buffer.from(script, "utf16le").toString("base64")
  return execSync(`powershell.exe -NoProfile -NonInteractive -EncodedCommand ${b64}`, {
    encoding: "utf8",
  }).trim()
}

function getPowershellPids(): number[] {
  if (process.platform !== "win32") return []
  try {
    const out = runPs(
      `(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.ProcessId -ne $PID } | ForEach-Object { $_.ProcessId }) -join ','`,
    )
    return out ? out.split(",").map(Number).filter(Boolean) : []
  } catch {
    return []
  }
}

function getStaPids(): number[] {
  if (process.platform !== "win32") return []
  try {
    const out = runPs(
      `(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -match '-STA' } | ForEach-Object { $_.ProcessId }) -join ','`,
    )
    return out ? out.split(",").map(Number).filter(Boolean) : []
  } catch {
    return []
  }
}

function getChildPowershellPids(): number[] {
  if (process.platform !== "win32") return []
  try {
    const out = runPs(
      `(Get-CimInstance Win32_Process -Filter "ParentProcessId=${process.pid} and Name='powershell.exe'" | ForEach-Object { $_.ProcessId }) -join ','`,
    )
    return out ? out.split(",").map(Number).filter(Boolean) : []
  } catch {
    return []
  }
}

const callRealDesktopScreenshot = (envVal: string | undefined) =>
  Effect.scoped(
    Effect.gen(function* () {
      const prev = process.env.ORCHESTRA_DESKTOP_CAPTURE
      if (envVal !== undefined) {
        process.env.ORCHESTRA_DESKTOP_CAPTURE = envVal
      } else {
        delete process.env.ORCHESTRA_DESKTOP_CAPTURE
      }

      try {
        const tools = yield* Tool.Service
        yield* registerToolPlugin(DesktopTool.Plugin)
        const snapshot = yield* tools.snapshot()
        return yield* snapshot.execute({
          call: { type: "tool-call", id: "call-1", name: "desktop_screenshot", input: {} },
          sessionID: Session.ID.make("ses_gate_test"),
          ...toolIdentity,
          agent: Agent.ID.make("test-agent"),
        })
      } finally {
        if (prev !== undefined) process.env.ORCHESTRA_DESKTOP_CAPTURE = prev
        else delete process.env.ORCHESTRA_DESKTOP_CAPTURE
      }
    }),
  ).pipe(Effect.provide(PluginTestLayer))

test("desktop gate: default-off, real desktop_screenshot execution, and no powershell processes", async () => {
  // Snapshot initial powershell count and STA processes
  const initialSta = getStaPids()
  const initialAll = getPowershellPids()
  expect(getChildPowershellPids().length).toBe(0)

  // 1. When ORCHESTRA_DESKTOP_CAPTURE is undefined (default)
  delete process.env.ORCHESTRA_DESKTOP_CAPTURE
  expect(DesktopTool.isDesktopCaptureEnabled()).toBe(false)

  // Direct makeHost must fail before spawning process
  const host = DesktopTool.makeHost()
  await expect(host.call("1")).rejects.toThrow(
    "Desktop access is off by default. Set ORCHESTRA_DESKTOP_CAPTURE=on to allow it.",
  )
  host.close()

  // 2. Real desktop_screenshot execution through Tool layer with env undefined must fail with gate message
  const exitDefault = await Effect.runPromiseExit(callRealDesktopScreenshot(undefined))
  expect(exitDefault._tag).toBe("Failure")
  if (exitDefault._tag === "Failure") {
    const err = Cause.squash(exitDefault.cause)
    expect((err as any)?.message).toBe(
      "Desktop access is off by default. Set ORCHESTRA_DESKTOP_CAPTURE=on to allow it.",
    )
  }

  // 3. Real desktop_screenshot execution with ORCHESTRA_DESKTOP_CAPTURE=off must also fail with gate message
  const exitOff = await Effect.runPromiseExit(callRealDesktopScreenshot("off"))
  expect(exitOff._tag).toBe("Failure")
  if (exitOff._tag === "Failure") {
    const err = Cause.squash(exitOff.cause)
    expect((err as any)?.message).toBe(
      "Desktop access is off by default. Set ORCHESTRA_DESKTOP_CAPTURE=on to allow it.",
    )
  }

  // 4. Verify no new -STA powershell processes and no child powershell processes spawned
  const newSta = getStaPids().filter((pid) => !initialSta.includes(pid))
  expect(newSta.length).toBe(0)
  const newAll = getPowershellPids().filter((pid) => !initialAll.includes(pid))
  expect(newAll.length).toBe(0)
  expect(getChildPowershellPids().length).toBe(0)

  // 5. With ORCHESTRA_DESKTOP_CAPTURE=on, the result is DIFFERENT (gate passes)
  expect(DesktopTool.isDesktopCaptureEnabled()).toBe(false) // still false outside
  process.env.ORCHESTRA_DESKTOP_CAPTURE = "on"
  expect(DesktopTool.isDesktopCaptureEnabled()).toBe(true)

  // In "on" mode, it passes the gate and proceeds to host/permission stage
  // (does NOT fail with the gate message)
  let onFailedWithGateMessage = false
  try {
    const exitOn = await Effect.runPromiseExit(callRealDesktopScreenshot("on"))
    if (exitOn._tag === "Failure") {
      const err = Cause.squash(exitOn.cause)
      if ((err as any)?.message?.includes("Desktop access is off by default")) {
        onFailedWithGateMessage = true
      }
    }
  } finally {
    delete process.env.ORCHESTRA_DESKTOP_CAPTURE
  }
  expect(onFailedWithGateMessage).toBe(false)

  // 6. Final verification: no child processes left
  expect(getChildPowershellPids().length).toBe(0)
}, 60000)
