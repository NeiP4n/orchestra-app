// Autonomous AI workspace: a "Machine" is a dedicated PC for an AI agent.
// It is a desktop-only concept: the TUI has no separate workspace.
// Backends are lightweight virtualization only. VirtualBox is deliberately
// absent: it is heavy, and every backend below is either a microVM, a
// native hypervisor, or (as a clearly-labelled fallback) a container.

export type MachineBackend = "firecracker" | "qemu-kvm" | "apple-vz" | "wsl" | "container"

export type MachineStatus =
  | "creating"
  | "stopped"
  | "starting"
  | "running"
  | "stopping"
  | "error"
  | "destroying"

export interface MachineSpec {
  name: string
  backend: MachineBackend
  cpu: number
  memoryMb: number
  diskGb: number
  network: boolean
}

export interface Machine extends MachineSpec {
  id: string
  status: MachineStatus
  snapshotId?: string
  projectId?: string
  createdAt: number
}

export type Platform = "linux" | "darwin" | "win32"

export interface HypervisorAvailability {
  kvm: boolean
  firecracker: boolean
  appleVz: boolean
  wsl: boolean
  container: boolean
}

// Pick the lightest real VM available on this platform, in priority order.
// A container is only a fallback and must be labelled as such in the UI:
// it is not a full PC (no own kernel, weaker isolation).
export function pickBackend(platform: Platform, available: HypervisorAvailability): MachineBackend {
  if (platform === "linux" && available.firecracker) return "firecracker"

  if (platform === "linux" && available.kvm) return "qemu-kvm"

  if (platform === "darwin" && available.appleVz) return "apple-vz"

  if (platform === "win32" && available.wsl) return "wsl"

  if (available.container) return "container"

  throw new Error("No machine backend available")
}

export function isFullVm(backend: MachineBackend): boolean {
  return backend !== "container"
}

const allowedTransitions: Record<MachineStatus, readonly MachineStatus[]> = {
  creating: ["stopped", "error"],
  stopped: ["starting", "destroying"],
  starting: ["running", "error", "stopping"],
  running: ["stopping", "error"],
  stopping: ["stopped", "error"],
  error: ["starting", "destroying"],
  destroying: [],
}

export function canTransition(from: MachineStatus, to: MachineStatus): boolean {
  return allowedTransitions[from].includes(to)
}

export function transition(machine: Machine, to: MachineStatus): Machine {
  if (!canTransition(machine.status, to)) {
    throw new Error(`Machine ${machine.id} cannot move from ${machine.status} to ${to}`)
  }

  return { ...machine, status: to }
}

export function validateSpec(spec: MachineSpec): void {
  if (!spec.name.trim()) throw new Error("Machine name is required")

  if (spec.cpu < 1) throw new Error("Machine cpu must be at least 1")

  if (spec.memoryMb < 256) throw new Error("Machine memoryMb must be at least 256")

  if (spec.diskGb < 1) throw new Error("Machine diskGb must be at least 1")
}
