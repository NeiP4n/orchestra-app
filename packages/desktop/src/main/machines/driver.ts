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
