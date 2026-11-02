import { describe, expect, test } from "bun:test"
import {
  containerExecCommand,
  containerLogsCommand,
  containerName,
  containerRemoveCommand,
  containerSnapshotCommand,
  containerStartCommand,
  containerStatusCommand,
  containerStopCommand,
  resolveContainerRuntime,
  snapshotImage,
} from "./driver"
import type { Machine } from "./store"

const machine: Machine = {
  id: "m1",
  name: "ai-pc",
  backend: "container",
  cpu: 2,
  memoryMb: 2048,
  diskGb: 20,
  network: false,
  status: "stopped",
  createdAt: 0,
}

describe("container machine driver", () => {
  test("builds a detached, network-isolated start command with resource limits", () => {
    expect(containerStartCommand("docker", machine)).toEqual([
      "docker",
      "run",
      "-d",
      "--name",
      "orchestra-machine-m1",
      "--cpus",
      "2",
      "--memory",
      "2048m",
      "--network",
      "none",
      "orchestra-machine:local",
      "sleep",
      "infinity",
    ])
  })

  test("stop, remove, exec and status use the same sanitized container name", () => {
    expect(containerName("m/1")).toBe("orchestra-machine-m-1")
    expect(containerStopCommand("podman", machine)).toEqual(["podman", "stop", "orchestra-machine-m1"])
    expect(containerRemoveCommand("podman", machine)).toEqual(["podman", "rm", "orchestra-machine-m1"])
    expect(containerExecCommand("docker", machine, ["bun", "--version"])).toEqual([
      "docker",
      "exec",
      "orchestra-machine-m1",
      "bun",
      "--version",
    ])
    expect(containerStatusCommand("docker", machine)).toEqual([
      "docker",
      "inspect",
      "-f",
      "{{.State.Running}}",
      "orchestra-machine-m1",
    ])
  })

  test("logs tails the last 100 lines of the container", () => {
    expect(containerLogsCommand("docker", machine)).toEqual([
      "docker",
      "logs",
      "--tail",
      "100",
      "orchestra-machine-m1",
    ])
  })

  test("snapshot commits the container to a machine-scoped image", () => {
    expect(snapshotImage(machine, "snap_1")).toBe("orchestra-machine-m1:snap_1")
    expect(containerSnapshotCommand("docker", machine, "snap_1")).toEqual([
      "docker",
      "commit",
      "orchestra-machine-m1",
      "orchestra-machine-m1:snap_1",
    ])
  })

  test("prefers docker, falls back to podman, and refuses when neither exists", () => {
    expect(resolveContainerRuntime(["podman", "docker"])).toBe("docker")
    expect(resolveContainerRuntime(["podman"])).toBe("podman")
    expect(() => resolveContainerRuntime([])).toThrow("No container runtime available")
  })
})
