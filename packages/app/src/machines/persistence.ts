// Machines persistence over the platform storage namespace "machines".
// On desktop this is the same sqlite-backed namespace the main-process
// Machines IPC handlers write to, so a machine created by IPC and a
// machine created by this panel read the same rows. On web the same
// namespace falls back to localStorage. The adapter only knows a
// key-value storage with enumeration, so it can be tested with a fake
// in-memory storage without Electron or a browser.

import type { Machine } from "./machine"

export interface MachineStorage {
  getLength(): Promise<number>
  key(index: number): Promise<string | null>
  getItem(key: string): Promise<string | null>
  setItem(key: string, value: string): Promise<void>
  removeItem(key: string): Promise<void>
  flush?(): Promise<void>
}

export async function loadMachines(storage: MachineStorage): Promise<Machine[]> {
  const length = await storage.getLength()
  const machines: Machine[] = []

  for (let index = 0; index < length; index++) {
    const key = await storage.key(index)

    if (!key) continue

    const value = await storage.getItem(key)

    if (!value) continue

    try {
      // SAFETY: the field checks below reject anything that is not a
      // machine-shaped record, and corrupt rows are skipped, not trusted.
      const parsed = JSON.parse(value) as Machine

      if (parsed.id && parsed.name && parsed.backend && parsed.status) machines.push(parsed)
    } catch {
      // A corrupt row must not hide every other machine.
      continue
    }
  }

  return machines
}

export async function saveMachine(storage: MachineStorage, machine: Machine): Promise<void> {
  await storage.setItem(machine.id, JSON.stringify(machine))

  if (storage.flush) await storage.flush()
}

export async function removeMachineRecord(storage: MachineStorage, id: string): Promise<void> {
  await storage.removeItem(id)

  if (storage.flush) await storage.flush()
}
