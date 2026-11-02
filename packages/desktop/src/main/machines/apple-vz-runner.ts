// Apple Vz runner: spawn the native orchestra-vz helper for a machine
// and keep the spawned process handle so IPC stop can kill it. The
// helper runs the VM in the foreground, so killing the helper stops
// the VM; there is no separate stop command yet (see main.swift).
// Kernel and disk paths come from the caller, never invented here.
// The spawn function is injected so tests can prove the exact command
// without macOS or the helper binary.

import { appleVzStartCommand, type AppleVzConfig } from "./apple-vz"
import type { SpawnedProcess, SpawnFunction } from "./firecracker-spawn"
import type { Machine } from "./store"

export type { SpawnedProcess, SpawnFunction }

export function spawnAppleVzMachine(spawnFn: SpawnFunction, machine: Machine, config: AppleVzConfig): SpawnedProcess {
  if (!config.kernelPath.trim()) throw new Error("Apple Vz kernel path is required")

  if (!config.diskPath.trim()) throw new Error("Apple Vz disk path is required")

  const command = appleVzStartCommand(machine, config)

  return spawnFn(command[0], command.slice(1))
}
