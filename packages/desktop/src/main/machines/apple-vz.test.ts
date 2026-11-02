import { describe, expect, test } from "bun:test"
import { appleVzStartCommand, appleVzStatusCommand, appleVzStopCommand } from "./apple-vz"
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

const config = { kernelPath: "/tmp/vmlinux", diskPath: "/tmp/disk.img" }

describe("apple-vz driver", () => {
  test("start passes cpu, memory, kernel and disk to the helper", () => {
    expect(appleVzStartCommand(machine, config)).toEqual([
      "orchestra-vz",
      "start",
      "--id",
      "m1",
      "--cpu",
      "2",
      "--memory",
      "2048",
      "--kernel",
      "/tmp/vmlinux",
      "--disk",
      "/tmp/disk.img",
    ])
  })

  test("stop and status pass only the machine id", () => {
    expect(appleVzStopCommand(machine, config)).toEqual(["orchestra-vz", "stop", "--id", "m1"])
    expect(appleVzStatusCommand(machine, config)).toEqual(["orchestra-vz", "status", "--id", "m1"])
  })

  test("a custom helper path is used when supplied", () => {
    expect(appleVzStartCommand(machine, { ...config, helperPath: "/usr/local/bin/orchestra-vz" })[0]).toBe(
      "/usr/local/bin/orchestra-vz",
    )
  })
})
