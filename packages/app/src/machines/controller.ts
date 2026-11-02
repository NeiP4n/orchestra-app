// Machines panel state: pure list operations over the Phase A machine model.
// The route component holds this list in a single createStore; desktop IPC
// (Phase B) will replace the in-memory list with the sqlite-backed one, but
// the transitions and validation stay identical on both sides.

import { transition, validateSpec, type Machine, type MachineSpec } from "./machine"

export function addMachine(machines: readonly Machine[], spec: MachineSpec, id: string, createdAt: number): Machine[] {
  validateSpec(spec)

  if (machines.some((machine) => machine.id === id)) throw new Error(`Machine ${id} already exists`)

  return [...machines, { ...spec, id, status: "creating", createdAt }]
}

export function startMachine(machines: readonly Machine[], id: string): Machine[] {
  return machines.map((machine) => {
    if (machine.id !== id) return machine

    if (machine.status === "stopped") return transition(machine, "starting")

    if (machine.status === "error") return transition(machine, "starting")

    throw new Error(`Machine ${id} cannot start from ${machine.status}`)
  })
}

export function stopMachine(machines: readonly Machine[], id: string): Machine[] {
  return machines.map((machine) => {
    if (machine.id !== id) return machine

    if (machine.status === "running" || machine.status === "starting") return transition(machine, "stopping")

    throw new Error(`Machine ${id} cannot stop from ${machine.status}`)
  })
}

export function removeMachine(machines: readonly Machine[], id: string): Machine[] {
  if (!machines.some((machine) => machine.id === id)) throw new Error(`Machine ${id} not found`)

  return machines.filter((machine) => machine.id !== id)
}
