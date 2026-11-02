// Desktop machines store: pure logic over the sqlite-backed state namespace.
// The main-process handler only translates between this store and
// DesktopStorage.state; all rules live here so bun test can prove them
// without Electron. No VirtualBox backend exists here either.

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

const allowedTransitions: Record<MachineStatus, readonly MachineStatus[]> = {
  creating: ["stopped", "error"],
  stopped: ["starting", "destroying"],
  starting: ["running", "error", "stopping"],
  running: ["stopping", "error"],
  stopping: ["stopped", "error"],
  error: ["starting", "destroying"],
  destroying: [],
}

export function parseMachine(value: string): Machine {
  // SAFETY: the handler only writes JSON produced from a Machine, and the
  // field checks below reject anything that is not a machine-shaped record.
  const parsed = JSON.parse(value) as Machine

  if (!parsed.id || !parsed.name || !parsed.backend || !parsed.status) {
    throw new Error("Stored machine is missing required fields")
  }

  return parsed
}

export function listMachines(items: Record<string, string>): Machine[] {
  return Object.values(items).map((value) => parseMachine(value))
}

export function createMachine(items: Record<string, string>, spec: MachineSpec, id: string, createdAt: number) {
  if (items[id]) throw new Error(`Machine ${id} already exists`)

  if (!spec.name.trim()) throw new Error("Machine name is required")

  if (spec.cpu < 1 || spec.memoryMb < 256 || spec.diskGb < 1) {
    throw new Error("Machine resources are below minimum")
  }

  const machine: Machine = { ...spec, id, status: "creating", createdAt }

  return { items: { ...items, [id]: JSON.stringify(machine) }, machine }
}

export function updateMachineStatus(items: Record<string, string>, id: string, to: MachineStatus) {
  const raw = items[id]

  if (!raw) throw new Error(`Machine ${id} not found`)

  const machine = parseMachine(raw)

  if (!allowedTransitions[machine.status].includes(to)) {
    throw new Error(`Machine ${id} cannot move from ${machine.status} to ${to}`)
  }

  const next = { ...machine, status: to }

  return { items: { ...items, [id]: JSON.stringify(next) }, machine: next }
}

export function deleteMachine(items: Record<string, string>, id: string) {
  if (!items[id]) throw new Error(`Machine ${id} not found`)

  const next = { ...items }

  delete next[id]

  return next
}
