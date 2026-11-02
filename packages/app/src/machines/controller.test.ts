import { describe, expect, test } from "bun:test"
import { addMachine, removeMachine, startMachine, stopMachine } from "./controller"
import type { MachineSpec } from "./machine"

const spec: MachineSpec = {
  name: "ai-pc",
  backend: "firecracker",
  cpu: 2,
  memoryMb: 2048,
  diskGb: 20,
  network: false,
}

describe("machines panel controller", () => {
  test("add, start and stop follow the machine status rules", () => {
    const added = addMachine([], spec, "m1", 1000)

    expect(added[0].status).toBe("creating")

    const stopped = added.map((machine) => ({ ...machine, status: "stopped" as const }))
    const started = startMachine(stopped, "m1")

    expect(started[0].status).toBe("starting")

    const running = started.map((machine) => ({ ...machine, status: "running" as const }))
    const stoppedAgain = stopMachine(running, "m1")

    expect(stoppedAgain[0].status).toBe("stopping")
    expect(removeMachine(stoppedAgain, "m1")).toEqual([])
  })

  test("starting a creating machine and removing an unknown machine fail", () => {
    const added = addMachine([], spec, "m1", 1000)

    expect(() => startMachine(added, "m1")).toThrow()
    expect(() => removeMachine(added, "missing")).toThrow()
    expect(() => addMachine(added, spec, "m1", 1000)).toThrow()
  })
})
