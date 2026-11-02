import { describe, expect, test } from "bun:test"
import {
  createMachine,
  deleteMachine,
  listMachines,
  setMachineSnapshot,
  updateMachineStatus,
  type MachineSpec,
} from "./store"

const spec: MachineSpec = {
  name: "ai-pc",
  backend: "firecracker",
  cpu: 2,
  memoryMb: 2048,
  diskGb: 20,
  network: false,
}

describe("desktop machines store", () => {
  test("create, list, transition, delete round-trips through plain records", () => {
    const created = createMachine({}, spec, "m1", 1000)

    expect(created.machine.status).toBe("creating")
    expect(listMachines(created.items)).toHaveLength(1)

    const started = updateMachineStatus(
      updateMachineStatus(created.items, "m1", "stopped").items,
      "m1",
      "starting",
    )

    expect(started.machine.status).toBe("starting")
    expect(deleteMachine(started.items, "m1")).toEqual({})
  })

  test("illegal transitions and unknown machines fail", () => {
    const created = createMachine({}, spec, "m1", 1000)

    expect(() => updateMachineStatus(created.items, "m1", "running")).toThrow()
    expect(() => updateMachineStatus(created.items, "missing", "stopped")).toThrow()
    expect(() => deleteMachine(created.items, "missing")).toThrow()
    expect(() => createMachine(created.items, spec, "m1", 1000)).toThrow()
  })

  test("snapshot id is stored on the machine without changing its status", () => {
    const created = createMachine({}, spec, "m1", 1000)
    const snapshotted = setMachineSnapshot(created.items, "m1", "snap_1")

    expect(snapshotted.machine.snapshotId).toBe("snap_1")
    expect(snapshotted.machine.status).toBe("creating")
    expect(() => setMachineSnapshot(created.items, "missing", "snap_1")).toThrow()
  })

  test("bad specs fail before any record is written", () => {
    expect(() => createMachine({}, { ...spec, name: " " }, "m1", 1000)).toThrow()
    expect(() => createMachine({}, { ...spec, memoryMb: 128 }, "m1", 1000)).toThrow()
  })
})
