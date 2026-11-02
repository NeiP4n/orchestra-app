// Container machine runner: executes driver commands through an injected
// executor, so the start/stop/exec/status logic is testable with a fake
// executor even where docker is not installed. The desktop main process
// supplies the real execFile executor below; this module never imports
// Electron, and never invents a success: a non-zero exit code is an error,
// and the caller must move the machine to the error status instead of
// reporting it running.

import { execFile } from "node:child_process"
import {
  containerExecCommand,
  containerLogsCommand,
  containerNetworkCommand,
  containerRemoveCommand,
  containerSnapshotCommand,
  containerStartCommand,
  containerStatusCommand,
  containerStopCommand,
  resolveContainerRuntime,
  type ContainerRuntime,
} from "./driver"
import type { Machine } from "./store"

export interface ExecResult {
  stdout: string
  exitCode: number
}

export type Executor = (command: readonly string[]) => Promise<ExecResult>

// Real executor for the desktop main process: execFile, never a shell, so
// a machine id or argument cannot inject a shell command. A rejected
// execFile (non-zero exit) is normalised to an ExecResult, so callers see
// exit codes instead of exceptions and decide the machine status.
export function createExecFileExecutor(): Executor {
  return (command) =>
    new Promise<ExecResult>((resolve) => {
      execFile(command[0], command.slice(1), (error, stdout) => {
        const code = error?.code !== undefined ? Number(error.code) : error ? 1 : 0

        resolve({ stdout: stdout.toString(), exitCode: Number.isNaN(code) ? 1 : code })
      })
    })
}

export async function detectContainerRuntime(exec: Executor): Promise<ContainerRuntime> {
  const available: ContainerRuntime[] = []

  for (const runtime of ["docker", "podman"] as const) {
    const result = await exec(["which", runtime])

    if (result.exitCode === 0) available.push(runtime)
  }

  return resolveContainerRuntime(available)
}

async function run(exec: Executor, command: readonly string[]): Promise<ExecResult> {
  const result = await exec(command)

  if (result.exitCode !== 0) {
    throw new Error(`Command failed (${result.exitCode}): ${command[0]} ${command.slice(1).join(" ")}`)
  }

  return result
}

export function startContainer(exec: Executor, runtime: ContainerRuntime, machine: Machine): Promise<ExecResult> {
  return run(exec, containerStartCommand(runtime, machine))
}

export function stopContainer(exec: Executor, runtime: ContainerRuntime, machine: Machine): Promise<ExecResult> {
  return run(exec, containerStopCommand(runtime, machine))
}

export function removeContainer(exec: Executor, runtime: ContainerRuntime, machine: Machine): Promise<ExecResult> {
  return run(exec, containerRemoveCommand(runtime, machine))
}

export function execInContainer(
  exec: Executor,
  runtime: ContainerRuntime,
  machine: Machine,
  command: readonly string[],
): Promise<ExecResult> {
  return run(exec, containerExecCommand(runtime, machine, command))
}

export function logsContainer(
  exec: Executor,
  runtime: ContainerRuntime,
  machine: Machine,
): Promise<ExecResult> {
  return run(exec, containerLogsCommand(runtime, machine))
}

export function setContainerNetwork(
  exec: Executor,
  runtime: ContainerRuntime,
  machine: Machine,
  network: boolean,
): Promise<ExecResult> {
  return run(exec, containerNetworkCommand(runtime, machine, network))
}

export function snapshotContainer(
  exec: Executor,
  runtime: ContainerRuntime,
  machine: Machine,
  snapshotId: string,
): Promise<ExecResult> {
  return run(exec, containerSnapshotCommand(runtime, machine, snapshotId))
}

export async function isContainerRunning(
  exec: Executor,
  runtime: ContainerRuntime,
  machine: Machine,
): Promise<boolean> {
  const result = await run(exec, containerStatusCommand(runtime, machine))

  return result.stdout.trim() === "true"
}
