import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { ShellSelect } from "@orchestra/core/shell/select"

const bash = "C:\\Program Files\\Git\\bin\\bash.exe"
// The MSYS bash itself, which SHELL=/usr/bin/bash resolves to: unlike the bin\ wrapper it adds nothing to PATH.
const msys = "C:\\Program Files\\Git\\usr\\bin\\bash.exe"

describe.skipIf(process.platform !== "win32" || !existsSync(bash))("Git Bash PATH", () => {
  test("puts the MSYS tools in front of a Windows PATH that lacks them", () => {
    const env = ShellSelect.withGitbashPath(bash, { Path: "C:\\Windows;C:\\Program Files\\Git\\cmd" })
    expect(env.Path?.split(";").slice(0, 2)).toEqual([
      "C:\\Program Files\\Git\\usr\\bin",
      "C:\\Program Files\\Git\\mingw64\\bin",
    ])
    expect(env.Path).toContain("C:\\Windows")
  })

  test("leaves the environment alone when the tools are already there or the shell is not bash", () => {
    const ready = { PATH: "C:\\Program Files\\Git\\usr\\bin;C:\\Program Files\\Git\\mingw64\\bin;C:\\Windows" }
    expect(ShellSelect.withGitbashPath(bash, ready)).toBe(ready)
    const other = { Path: "C:\\Windows" }
    expect(ShellSelect.withGitbashPath("C:\\Windows\\System32\\cmd.exe", other)).toBe(other)
  })

  test("a command run through the MSYS bash finds ls and wc even with a bare Windows PATH", async () => {
    const run = async (env: Record<string, string | undefined>) => {
      const proc = Bun.spawn([msys, "-c", "ls / | wc -l"], { env, stdout: "pipe", stderr: "pipe" })
      return proc.exited
    }
    const bare = { Path: "C:\\Windows\\System32" }
    expect(await run(bare)).toBe(127)
    expect(await run(ShellSelect.withGitbashPath(msys, bare))).toBe(0)
  })
})
