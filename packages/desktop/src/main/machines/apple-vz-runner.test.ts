import { describe, expect, test } from "bun:test"
import { spawnAppleVzMachine } from "./apple-vz-runner"
import type { Machine } from "./store"

const machine: Machine = {
  id: "m1",
  name: "ai-pc",
  backend: "apple-vz",
  cpu: 2,
  memoryMb: 2048,
  diskGb: 20,
  network: false,
  status: "stopped",
  createdAt: 0,
}

describe("apple-vz runner", () => {
  test("spawn passes the helper start command and returns the process handle", () => {
    let killed = false
    const calls: { command: string; args: readonly string[] }[] = []
    const handle = spawnAppleVzMachine(
      (command, args) => {
        calls.push({ command, args })

        return { pid: 123, kill: () => void (killed = true) }
      },
      machine,
      { kernelPath: "/tmp/vmlinux", diskPath: "/tmp/disk.img" },
    )

    expect(calls).toEqual([
      {
        command: "orchestra-vz",
        args: ["start", "--id", "m1", "--cpu", "2", "--memory", "2048", "--kernel", "/tmp/vmlinux", "--disk", "/tmp/disk.img"],
      },
    ])

    handle.kill()

    expect(killed).toBe(true)
  })

  test("missing kernel or disk fails before spawning", () => {
    const spawn = () => {
      throw new Error("should not spawn")
    }

    expect(() => spawnAppleVzMachine(spawn, machine, { kernelPath: "", diskPath: "/tmp/disk.img" })).toThrow(
      "kernel path is required",
    )
    expect(() => spawnAppleVzMachine(spawn, machine, { kernelPath: "/tmp/vmlinux", diskPath: "" })).toThrow(
      "disk path is required",
    )
  })
})
