// Machine drivers: the command layer for the container fallback backend.
// This module builds commands only; it never spawns a process, so bun test
// can prove the exact docker/podman invocation without docker installed.
// The desktop main process will spawn these commands in the next step, and
// must refuse to start a machine when no runtime is available instead of
// pretending a VM exists. The container backend is NOT a full PC: it has no
// own kernel, and the UI must keep labelling it as a container.

import type { Machine } from "./store"

export type ContainerRuntime = "docker" | "podman"

export function containerName(machineId: string): string {
  return `orchestra-machine-${machineId.replace(/[^a-zA-Z0-9_-]/g, "-")}`
}

export function resolveContainerRuntime(available: readonly ContainerRuntime[]): ContainerRuntime {
  if (available.includes("docker")) return "docker"

  if (available.includes("podman")) return "podman"

  throw new Error("No container runtime available (docker or podman)")
}

// The image is built from packages/containers/base/Dockerfile by the user
// or CI; the driver never assumes a published image is already present.
export function containerStartCommand(
  runtime: ContainerRuntime,
  machine: Machine,
  image = "orchestra-machine:local",
): string[] {
  return [
    runtime,
    "run",
    "-d",
    "--name",
    containerName(machine.id),
    "--cpus",
    String(machine.cpu),
    "--memory",
    `${machine.memoryMb}m`,
    "--network",
    machine.network ? "bridge" : "none",
    image,
    "sleep",
    "infinity",
  ]
}

export function containerStopCommand(runtime: ContainerRuntime, machine: Machine): string[] {
  return [runtime, "stop", containerName(machine.id)]
}

export function containerRemoveCommand(runtime: ContainerRuntime, machine: Machine): string[] {
  return [runtime, "rm", containerName(machine.id)]
}

export function containerExecCommand(runtime: ContainerRuntime, machine: Machine, command: readonly string[]): string[] {
  return [runtime, "exec", containerName(machine.id), ...command]
}

export function containerStatusCommand(runtime: ContainerRuntime, machine: Machine): string[] {
  return [runtime, "inspect", "-f", "{{.State.Running}}", containerName(machine.id)]
}

export function containerLogsCommand(runtime: ContainerRuntime, machine: Machine): string[] {
  return [runtime, "logs", "--tail", "100", containerName(machine.id)]
}

// Live network toggle for a running container: a container started with
// --network none gains the runtime's default network on connect, and loses
// it on disconnect, without a restart. The default network name differs
// by runtime (docker: "bridge", podman: "podman"), so it is not a user
// setting here — it is the network the runtime already provides.
export function defaultContainerNetwork(runtime: ContainerRuntime): string {
  return runtime === "docker" ? "bridge" : "podman"
}

export function containerNetworkCommand(
  runtime: ContainerRuntime,
  machine: Machine,
  network: boolean,
): string[] {
  return [
    runtime,
    "network",
    network ? "connect" : "disconnect",
    defaultContainerNetwork(runtime),
    containerName(machine.id),
  ]
}

// A container snapshot is a committed image of the machine's filesystem.
// Restoring it is starting a container from that image, via the existing
// start command with the snapshot image instead of the base image.
export function snapshotImage(machine: Machine, snapshotId: string): string {
  return `orchestra-machine-${machine.id}:${snapshotId}`
}

export function containerSnapshotCommand(runtime: ContainerRuntime, machine: Machine, snapshotId: string): string[] {
  return [runtime, "commit", containerName(machine.id), snapshotImage(machine, snapshotId)]
}
