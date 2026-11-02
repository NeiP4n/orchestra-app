// WSL machine driver (Windows only): command builder for the wsl CLI.
// A WSL machine is a registered distribution, not a container: import
// creates it from a tarball, -d runs a command inside it, --terminate
// stops it, --unregister destroys it. This module builds commands only,
// like the container driver, so bun test can prove them without Windows
// or WSL installed. The tarball path is supplied by the caller; this
// module never invents a distribution image.

import type { Machine } from "./store"

export function wslDistroName(machine: Machine): string {
  return `orchestra-machine-${machine.id.replace(/[^a-zA-Z0-9_-]/g, "-")}`
}

export function wslImportCommand(machine: Machine, installLocation: string, tarballPath: string): string[] {
  return ["wsl", "--import", wslDistroName(machine), installLocation, tarballPath]
}

export function wslExecCommand(machine: Machine, command: readonly string[]): string[] {
  return ["wsl", "-d", wslDistroName(machine), ...command]
}

export function wslTerminateCommand(machine: Machine): string[] {
  return ["wsl", "--terminate", wslDistroName(machine)]
}

export function wslUnregisterCommand(machine: Machine): string[] {
  return ["wsl", "--unregister", wslDistroName(machine)]
}

export function wslListCommand(): string[] {
  return ["wsl", "--list", "--verbose"]
}
