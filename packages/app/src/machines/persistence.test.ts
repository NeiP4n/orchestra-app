import { describe, expect, test } from "bun:test"
import { loadMachines, removeMachineRecord, saveMachine, type MachineStorage } from "./persistence"
import type { Machine } from "./machine"

function fakeStorage(): MachineStorage {
  const data = new Map<string, string>()

  return {
    async getLength() {
      return data.size
    },
    async key(index) {
      return [...data.keys()][index] ?? null
    },
    async getItem(key) {
      return data.get(key) ?? null
    },
    async setItem(key, value) {
      data.set(key, value)
    },
    async removeItem(key) {
      data.delete(key)
    },
    async flush() {},
  }
}

const machine: Machine = {
  id: "m1",
  name: "ai-pc",
  backend: "firecracker",
  cpu: 2,
  memoryMb: 2048,
  diskGb: 20,
  network: false,
  status: "stopped",
  createdAt: 0,
}

describe("machines persistence", () => {
  test("save, load and remove round-trip through key-value storage", async () => {
    const storage = fakeStorage()

    await saveMachine(storage, machine)

    expect(await loadMachines(storage)).toEqual([machine])

    await removeMachineRecord(storage, "m1")

    expect(await loadMachines(storage)).toEqual([])
  })

  test("a corrupt row does not hide valid machines", async () => {
    const storage = fakeStorage()

    await storage.setItem("bad", "not-json")
    await saveMachine(storage, machine)

    expect(await loadMachines(storage)).toEqual([machine])
  })
})
