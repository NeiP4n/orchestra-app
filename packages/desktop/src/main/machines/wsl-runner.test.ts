import { describe, expect, test } from "bun:test"
import { importWslMachine, spawnWslKeepAlive, terminateWslMachine, verifyWslMachine } from "./wsl-runner"
import type { Machine } from "./store"

const machine: Machine = {
  id: "m1",
  name: "ai-pc",
  backend: "wsl",
  cpu: 2,
  memoryMb: 2048,
  diskGb: 20,
  network: false,
  status: "stopped",
  createdAt: 0,
}

describe("wsl runner", () => {
  test("verify runs true inside the distribution and fails on non-zero exit", async () => {
    const calls: readonly string[][] = []

    const exec = async (command: readonly string[]) => {
      calls.push([...command])

      return { stdout: "", exitCode: 0 }
    }

    await verifyWslMachine(exec, machine)

    expect(calls).toEqual([["wsl", "-d", "orchestra-machine-m1", "true"]])
    await expect(verifyWslMachine(async () => ({ stdout: "", exitCode: 1 }), machine)).rejects.toThrow(
      "not registered",
    )
    await expect(verifyWslMachine(async () => ({ stdout: "", exitCode: 1 }), machine)).rejects.toThrow(
      "wsl --import orchestra-machine-m1",
    )
  })

  test("keep-alive spawns sleep infinity inside the distribution", () => {
    let killed = false
    const calls: { command: string; args: readonly string[] }[] = []

    const handle = spawnWslKeepAlive(
      (command, args) => {
        calls.push({ command, args })

        return { pid: 7, kill: () => void (killed = true) }
      },
      machine,
    )

    expect(calls).toEqual([
      { command: "wsl", args: ["-d", "orchestra-machine-m1", "sleep", "infinity"] },
    ])

    handle.kill()

    expect(killed).toBe(true)
  })

  test("import and terminate pass through and fail on non-zero exit", async () => {
    const calls: readonly string[][] = []

    const exec = async (command: readonly string[]) => {
      calls.push([...command])

      return { stdout: "", exitCode: 0 }
    }

    await importWslMachine(exec, machine, "C:\\machines\\m1", "C:\\distros\\rootfs.tar.gz")
    await terminateWslMachine(exec, machine)

    expect(calls).toEqual([
      ["wsl", "--import", "orchestra-machine-m1", "C:\\machines\\m1", "C:\\distros\\rootfs.tar.gz"],
      ["wsl", "--terminate", "orchestra-machine-m1"],
    ])
    await expect(terminateWslMachine(async () => ({ stdout: "", exitCode: 1 }), machine)).rejects.toThrow(
      "terminate failed",
    )
  })
})
