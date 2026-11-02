// Container machine runner: executes driver commands through an injected
// executor, so the start/stop/exec/status logic is testable with a fake
// executor even where docker is not installed. The desktop main process
// supplies a real executor (node:child_process execFile); this module never
// imports Electron or child_process itself, and never invents a success:
// a non-zero exit code is an error, and the caller must move the machine
// to the error status instead of reporting it running.

import {
  containerExecCommand,
  containerRemoveCommand,
  containerStartCommand,
  containerStatusCommand,
  containerStopCommand,
  type ContainerRuntime,
} from "./driver"
import type { Machine } from "./store"

export interface ExecResult {
  stdout: string
  exitCode: number
}

export type Executor = (command: readonly string[]) => Promise<ExecResult>

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

export async function isContainerRunning(
  exec: Executor,
  runtime: ContainerRuntime,
  machine: Machine,
): Promise<boolean> {
  const result = await run(exec, containerStatusCommand(runtime, machine))

  return result.stdout.trim() === "true"
}
