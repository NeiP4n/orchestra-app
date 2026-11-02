import { describe, expect, test } from "bun:test"
import {
  wslDistroName,
  wslExecCommand,
  wslImportCommand,
  wslListCommand,
  wslTerminateCommand,
  wslUnregisterCommand,
} from "./wsl"
import type { Machine } from "./store"

const machine: Machine = {
  id: "m1",
  name: "ai-pc",
  backend: "wsl",
  cpu: 2,
  memoryMb: 2048,
  diskGb: 20,
  network: false,
  status: "stopped",
  createdAt: 0,
}

describe("wsl machine driver", () => {
  test("import, exec, terminate and unregister use the same distro name", () => {
    expect(wslDistroName(machine)).toBe("orchestra-machine-m1")
    expect(wslImportCommand(machine, "C:\\machines\\m1", "C:\\images\\base.tar")).toEqual([
      "wsl",
      "--import",
      "orchestra-machine-m1",
      "C:\\machines\\m1",
      "C:\\images\\base.tar",
    ])
    expect(wslExecCommand(machine, ["bun", "--version"])).toEqual([
      "wsl",
      "-d",
      "orchestra-machine-m1",
      "bun",
      "--version",
    ])
    expect(wslTerminateCommand(machine)).toEqual(["wsl", "--terminate", "orchestra-machine-m1"])
    expect(wslUnregisterCommand(machine)).toEqual(["wsl", "--unregister", "orchestra-machine-m1"])
    expect(wslListCommand()).toEqual(["wsl", "--list", "--verbose"])
  })
})
