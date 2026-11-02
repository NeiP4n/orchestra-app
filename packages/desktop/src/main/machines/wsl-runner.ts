// WSL machine runner (Windows only): run WSL driver commands through
// an injected executor, and spawn the keep-alive process that keeps a
// distribution running. A WSL distribution only stays up while a process
// runs inside it, so Start verifies the distribution with a short
// command, then spawns `sleep infinity` inside it and keeps the handle
// so Stop can kill it and terminate the distribution. Import is not
// done here: Start assumes the distribution is already registered
// (imported from a tarball beforehand); a missing distribution fails
// the verification command instead of reporting a phantom running VM.
// The spawn function is injected so tests can prove the exact command
// without Windows or WSL installed.

import { wslExecCommand, wslImportCommand, wslTerminateCommand } from "./wsl"
import type { SpawnedProcess, SpawnFunction } from "./firecracker-spawn"
import type { Machine } from "./store"

export type WslExecutor = (command: readonly string[]) => Promise<{ stdout: string; exitCode: number }>

export async function importWslMachine(
  exec: WslExecutor,
  machine: Machine,
  installLocation: string,
  tarballPath: string,
): Promise<void> {
  const result = await exec(wslImportCommand(machine, installLocation, tarballPath))

  if (result.exitCode !== 0) throw new Error(`WSL import failed with exit code ${result.exitCode}`)
}

export async function verifyWslMachine(exec: WslExecutor, machine: Machine): Promise<void> {
  const result = await exec(wslExecCommand(machine, ["true"]))

  // There is no import step in the app yet, so a missing distribution
  // must say exactly how to create it instead of a bare "not runnable":
  // the distribution name is derived from the machine id.
  if (result.exitCode !== 0)
    throw new Error(
      `WSL distribution for machine ${machine.id} is not registered or not runnable. ` +
        `Import it first: wsl --import orchestra-machine-${machine.id} <install-location> <tarball-path>`,
    )
}

export function spawnWslKeepAlive(spawnFn: SpawnFunction, machine: Machine): SpawnedProcess {
  const command = wslExecCommand(machine, ["sleep", "infinity"])

  return spawnFn(command[0], command.slice(1))
}

export async function terminateWslMachine(exec: WslExecutor, machine: Machine): Promise<void> {
  const result = await exec(wslTerminateCommand(machine))

  if (result.exitCode !== 0) throw new Error(`WSL terminate failed with exit code ${result.exitCode}`)
}
