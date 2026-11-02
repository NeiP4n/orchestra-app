import { describe, expect, test } from "bun:test"
import { canTransition, isFullVm, pickBackend, transition, validateSpec, type Machine } from "./machine"

const base: Machine = {
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

describe("machine backend selection", () => {
  test("prefers firecracker on linux, never virtualbox", () => {
    expect(pickBackend("linux", { kvm: true, firecracker: true, appleVz: false, wsl: false, container: true })).toBe(
      "firecracker",
    )
  })
  test("falls back to qemu-kvm, then container", () => {
    expect(pickBackend("linux", { kvm: true, firecracker: false, appleVz: false, wsl: false, container: true })).toBe(
      "qemu-kvm",
    )
    expect(pickBackend("linux", { kvm: false, firecracker: false, appleVz: false, wsl: false, container: true })).toBe(
      "container",
    )
  })
  test("uses native hypervisors on darwin and win32", () => {
    expect(pickBackend("darwin", { kvm: false, firecracker: false, appleVz: true, wsl: false, container: true })).toBe(
      "apple-vz",
    )
    expect(pickBackend("win32", { kvm: false, firecracker: false, appleVz: false, wsl: true, container: true })).toBe(
      "wsl",
    )
  })
  test("container is not a full vm", () => {
    expect(isFullVm("container")).toBe(false)
    expect(isFullVm("firecracker")).toBe(true)
  })
})

describe("machine status transitions", () => {
  test("stopped can start, running can stop, stopped cannot stop", () => {
    expect(canTransition("stopped", "starting")).toBe(true)
    expect(canTransition("running", "stopping")).toBe(true)
    expect(canTransition("stopped", "stopping")).toBe(false)
    expect(() => transition(base, "stopping")).toThrow()
    expect(transition(base, "starting").status).toBe("starting")
  })
  test("spec validation rejects empty name and tiny resources", () => {
    expect(() => validateSpec({ ...base, name: " " })).toThrow()
    expect(() => validateSpec({ ...base, memoryMb: 128 })).toThrow()
    expect(() => validateSpec(base)).not.toThrow()
  })
})
