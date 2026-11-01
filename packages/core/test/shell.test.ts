import { describe, expect, test } from "bun:test"
import child_process from "node:child_process"
import path from "path"
import { Effect } from "effect"
import { killProcessTree } from "@orchestra/core/shell"
import { ShellSelect } from "@orchestra/core/shell/select"
import { FSUtil } from "@orchestra/util/fs-util"
import { which } from "@orchestra/core/util/which"
import fs from "node:fs/promises"
import { tmpdir } from "./fixture/tmpdir"

const withShell = async (shell: string | undefined, fn: () => void | Promise<void>) => {
  const prev = process.env.SHELL
  if (shell === undefined) delete process.env.SHELL
  else process.env.SHELL = shell
  ShellSelect.resolve.reset()
  try {
    await fn()
  } finally {
    if (prev === undefined) delete process.env.SHELL
    else process.env.SHELL = prev
    ShellSelect.resolve.reset()
  }
}

describe("shell", () => {
  test("normalizes shell names", () => {
    expect(ShellSelect.name("/bin/bash")).toBe("bash")
    if (process.platform === "win32") {
      expect(ShellSelect.name("C:/tools/NU.EXE")).toBe("nu")
      expect(ShellSelect.name("C:/tools/PWSH.EXE")).toBe("pwsh")
    }
  })

  test("detects login shells", () => {
    expect(ShellSelect.login("/bin/bash")).toBe(true)
    expect(ShellSelect.login("C:/tools/pwsh.exe")).toBe(false)
  })

  test("falls back when configured shell cannot be resolved", async () => {
    await withShell(undefined, async () => {
      const configured = ShellSelect.resolve({ priority: "config" })
      const compatible = ShellSelect.resolve({ priority: "compat" })
      expect(ShellSelect.resolve({ priority: "config" }, "opencode-missing-shell")).toBe(configured)
      expect(ShellSelect.resolve({ priority: "compat" }, "opencode-missing-shell")).toBe(compatible)
    })
  })

  test("falls back for terminal-only shells when compatibility is required", () => {
    expect(ShellSelect.name(ShellSelect.resolve({ priority: "compat" }, "fish"))).not.toBe("fish")
  })

  test("uses nu only when the user configures it", async () => {
    const nu = Bun.which("nu")
    if (!nu) return
    expect(ShellSelect.name(ShellSelect.resolve({ priority: "compat" }, "nu"))).toBe("nu")
    await withShell(nu, async () => {
      expect(ShellSelect.name(ShellSelect.environment(undefined, { compatible: true }))).not.toBe("nu")
    })
  })

  test("builds command args per shell family", () => {
    expect(ShellSelect.args("/bin/sh", "echo hi")).toEqual(["-c", "echo hi"])
    expect(ShellSelect.args("/usr/bin/fish", "echo hi")).toEqual(["-c", "echo hi"])
    expect(ShellSelect.args("/bin/zsh", "echo hi")).toEqual(["-c", "echo hi"])
    expect(ShellSelect.args("/bin/bash", "echo hi")).toEqual(["-c", "echo hi"])
    expect(ShellSelect.args("pwsh", "Write-Output hi")).toEqual([
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Write-Output hi",
    ])
  })

  if (process.platform !== "win32") {
    test("resolves the environment shell without retaining a removed executable", async () => {
      await withShell(undefined, async () => {
        await using directory = await tmpdir()
        const fallback = ShellSelect.environment()
        const shell = path.join(directory.path, "preferred-shell")
        await fs.symlink("/bin/sh", shell)
        process.env.SHELL = shell
        expect(ShellSelect.environment()).toBe(shell)
        expect(ShellSelect.resolve({ priority: "config" })).toBe(shell)
        await fs.unlink(shell)
        expect(ShellSelect.environment()).toBe(fallback)
      })
    })
  }

  if (process.platform === "win32") {
    test("rejects blacklisted shells case-insensitively", async () => {
      await withShell("NU.EXE", async () => {
        expect(ShellSelect.name(ShellSelect.resolve({ priority: "compat" }))).not.toBe("nu")
      })
    })

    test("normalizes Git Bash shell paths from env", async () => {
      const shell = "/cygdrive/c/Program Files/Git/bin/bash.exe"
      await withShell(shell, async () => {
        expect(ShellSelect.resolve({ priority: "config" })).toBe(FSUtil.windowsPath(shell))
      })
    })

    test("resolves /usr/bin/bash from env to Git Bash", async () => {
      const bash = ShellSelect.gitbash()
      if (!bash) return
      await withShell("/usr/bin/bash", async () => {
        expect(ShellSelect.resolve({ priority: "compat" })).toBe(bash)
        expect(ShellSelect.resolve({ priority: "config" })).toBe(bash)
      })
    })

    test("resolves bare bash to Git Bash before PATH", async () => {
      const bash = ShellSelect.gitbash()
      if (!bash) return
      expect(ShellSelect.resolve({ priority: "compat" }, "bash")).toBe(bash)
      expect(ShellSelect.resolve({ priority: "config" }, "bash")).toBe(bash)
      await withShell("bash", async () => {
        expect(ShellSelect.resolve({ priority: "compat" })).toBe(bash)
        expect(ShellSelect.resolve({ priority: "config" })).toBe(bash)
      })
    })

    test("resolves bare PowerShell shells", async () => {
      const shell = which("pwsh") || which("powershell")
      if (!shell) return
      await withShell(path.win32.basename(shell), async () => {
        expect(ShellSelect.resolve({ priority: "config" })).toBe(shell)
      })
    })
  }

  describe("killProcessTree", () => {
    test("handles already exited or invalid process id gracefully", async () => {
      await Effect.runPromise(killProcessTree(99999999))
      await Effect.runPromise(killProcessTree(undefined))
    })

    test("calls handle.kill if handle is provided", async () => {
      let handleKilled = false
      const mockHandle = {
        kill: () =>
          Effect.sync(() => {
            handleKilled = true
          }),
      }
      await Effect.runPromise(killProcessTree(undefined, mockHandle as any))
      expect(handleKilled).toBe(true)
    })

    if (process.platform === "win32") {
      test("terminates entire process tree on Windows via taskkill", async () => {
        // Spawn parent (cmd.exe) which in turn spawns child (powershell.exe)
        const parent = child_process.spawn("cmd.exe", ["/c", "powershell.exe -NoProfile -Command Start-Sleep 30"], {
          windowsHide: true,
        })
        const parentPid = parent.pid!
        expect(parentPid).toBeGreaterThan(0)

        // Wait for child powershell process to be spawned
        await new Promise((resolve) => setTimeout(resolve, 1200))

        let childPid: number | undefined
        try {
          const stdout = child_process
            .execSync(
              `powershell.exe -NoProfile -Command "(Get-CimInstance Win32_Process -Filter \\"ParentProcessId = ${parentPid}\\").ProcessId"`,
            )
            .toString()
            .trim()
          const parsed = parseInt(stdout, 10)
          if (Number.isSafeInteger(parsed) && parsed > 0) {
            childPid = parsed
          }
        } catch {}

        const isAlive = (pid: number) => {
          try {
            process.kill(pid, 0)
            return true
          } catch {
            return false
          }
        }

        // Before kill: parent is alive
        expect(isAlive(parentPid)).toBe(true)
        if (childPid !== undefined) {
          expect(isAlive(childPid)).toBe(true)
        }

        // Execute killProcessTree on parent PID
        await Effect.runPromise(killProcessTree(parentPid))

        // Wait briefly for taskkill.exe /T /F to reap all descendant processes
        await new Promise((resolve) => setTimeout(resolve, 1000))

        // After kill: both parent and child must be dead
        expect(isAlive(parentPid)).toBe(false)
        if (childPid !== undefined) {
          expect(isAlive(childPid)).toBe(false)
        }
      }, 15000)
    }
  })
})
