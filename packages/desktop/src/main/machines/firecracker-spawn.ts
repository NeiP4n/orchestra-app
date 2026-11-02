// Firecracker process spawn: the long-running microVM process itself.
// The spawn function is injected so tests can prove the exact command
// without a real binary or /dev/kvm. The real spawner is node:child_process
// spawn with stdio ignored and detached false, so the desktop main process
// owns the VM process and killing it kills the VM. A stale socket file
// from a previous run must be removed before starting, otherwise
// Firecracker refuses to bind its API socket; the caller supplies that
// removal, this module only builds the command and validates the binary
// name is not empty. Kernel and rootfs assets are still required by the
// API client step that follows the spawn.

import { spawn as nodeSpawn } from "node:child_process"
import { firecrackerProcessCommand, firecrackerSocketPath } from "./firecracker"
import type { Machine } from "./store"

export interface SpawnedProcess {
  pid: number | undefined
  kill: () => void
}

export type SpawnFunction = (command: string, args: readonly string[]) => SpawnedProcess

export function createNodeSpawn(): SpawnFunction {
  return (command, args) => {
    const child = nodeSpawn(command, [...args], { stdio: "ignore", detached: false, windowsHide: true })

    return { pid: child.pid, kill: () => void child.kill() }
  }
}

export function spawnFirecrackerProcess(
  spawnFn: SpawnFunction,
  binary: string,
  machine: Machine,
): { child: SpawnedProcess; socketPath: string } {
  if (!binary.trim()) throw new Error("Firecracker binary path is required")

  const args = firecrackerProcessCommand(binary, machine)
  const child = spawnFn(args[0], args.slice(1))

  return { child, socketPath: firecrackerSocketPath(machine.id) }
}
