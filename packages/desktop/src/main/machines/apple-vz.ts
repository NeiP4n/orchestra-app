// Apple Virtualization.framework machine driver (macOS only): command
// builder for the native Swift helper in apple-vz/main.swift. There is no
// official Vz CLI to wrap, so the helper is a small binary that talks to
// Virtualization.framework directly. This module builds commands only,
// like the WSL driver, so bun test can prove them without macOS or the
// helper binary. The kernel image and disk image paths are supplied by
// the caller; this module never invents a guest image.

import type { Machine } from "./store"

export type AppleVzConfig = {
  kernelPath: string
  diskPath: string
  helperPath?: string
}

export function appleVzHelperPath(config: AppleVzConfig): string {
  return config.helperPath ?? "orchestra-vz"
}

export function appleVzStartCommand(machine: Machine, config: AppleVzConfig): string[] {
  return [
    appleVzHelperPath(config),
    "start",
    "--id",
    machine.id,
    "--cpu",
    String(machine.cpu),
    "--memory",
    String(machine.memoryMb),
    "--kernel",
    config.kernelPath,
    "--disk",
    config.diskPath,
  ]
}

export function appleVzStopCommand(machine: Machine, config: AppleVzConfig): string[] {
  return [appleVzHelperPath(config), "stop", "--id", machine.id]
}

export function appleVzStatusCommand(machine: Machine, config: AppleVzConfig): string[] {
  return [appleVzHelperPath(config), "status", "--id", machine.id]
}
