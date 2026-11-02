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

const backends: readonly string[] = ["firecracker", "qemu-kvm", "apple-vz", "wsl", "container"]

const statuses: readonly string[] = [
  "creating",
  "stopped",
  "starting",
  "running",
  "stopping",
  "error",
  "destroying",
]

export function parseMachine(value: string): Machine {
  // SAFETY: the handler only writes JSON produced from a Machine, and the
  // field checks below reject anything that is not a machine-shaped record.
  const parsed = JSON.parse(value) as Machine

  if (!parsed.id || !parsed.name || !parsed.backend || !parsed.status) {
    throw new Error("Stored machine is missing required fields")
  }

  // A bogus enum value is not a machine either: without this check, the
  // transition table lookup in updateMachineStatus throws a TypeError
  // instead of a clean error, and a corrupt row poisons the whole list.
  if (!backends.includes(parsed.backend) || !statuses.includes(parsed.status)) {
    throw new Error(`Stored machine ${parsed.id} has an unknown backend or status`)
  }

  return parsed
}

export function listMachines(items: Record<string, string>): Machine[] {
  // One corrupt row must not kill the whole list: skip it, like the app
  // side persistence already does. A single bad row used to make the
  // desktop machine list empty/broken.
  const machines: Machine[] = []

  for (const value of Object.values(items)) {
    try {
      machines.push(parseMachine(value))
    } catch {
      // Skip the corrupt row and keep the rest of the list usable.
    }
  }

  return machines
}

export function createMachine(items: Record<string, string>, spec: MachineSpec, id: string, createdAt: number) {
  if (items[id]) throw new Error(`Machine ${id} already exists`)

  if (!spec.name.trim()) throw new Error("Machine name is required")

  if (spec.cpu < 1 || spec.memoryMb < 256 || spec.diskGb < 1) {
    throw new Error("Machine resources are below minimum")
  }

  // Creation is synchronous: there is no async provisioning step, so a
  // new machine is immediately stopped and startable (see the app
  // controller for the same rule). Creating it as "creating" left it
  // stuck forever, because no handler ever transitioned it onward.
  const machine: Machine = { ...spec, id, status: "stopped", createdAt }

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

export function setMachineNetwork(items: Record<string, string>, id: string, network: boolean) {
  const raw = items[id]

  if (!raw) throw new Error(`Machine ${id} not found`)

  const next = { ...parseMachine(raw), network }

  return { items: { ...items, [id]: JSON.stringify(next) }, machine: next }
}

export function setMachineSnapshot(items: Record<string, string>, id: string, snapshotId: string) {
  const raw = items[id]

  if (!raw) throw new Error(`Machine ${id} not found`)

  const next = { ...parseMachine(raw), snapshotId }

  return { items: { ...items, [id]: JSON.stringify(next) }, machine: next }
}

export function deleteMachine(items: Record<string, string>, id: string) {
  if (!items[id]) throw new Error(`Machine ${id} not found`)

  const next = { ...items }

  delete next[id]

  return next
}
