import { describe, expect, test } from "bun:test"
import { createNodeSpawn, spawnFirecrackerProcess, type SpawnFunction } from "./firecracker-spawn"
import type { Machine } from "./store"

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

describe("firecracker process spawn", () => {
  test("spawns the binary with only the api-sock argument", () => {
    const seen: { command: string; args: readonly string[] }[] = []

    const fakeSpawn: SpawnFunction = (command, args) => {
      seen.push({ command, args })

      return { pid: 123, kill: () => undefined }
    }

    const result = spawnFirecrackerProcess(fakeSpawn, "firecracker", machine)

    expect(seen).toEqual([{ command: "firecracker", args: ["--api-sock", "/tmp/orchestra-machine-m1.socket"] }])
    expect(result.socketPath).toBe("/tmp/orchestra-machine-m1.socket")
    expect(result.child.pid).toBe(123)
  })

  test("an empty binary path fails before spawning", () => {
    const fakeSpawn: SpawnFunction = () => {
      throw new Error("should not spawn")
    }

    expect(() => spawnFirecrackerProcess(fakeSpawn, " ", machine)).toThrow("Firecracker binary path is required")
  })

  test("a missing binary records an error instead of throwing in the main process", async () => {
    const spawned = createNodeSpawn()("definitely-not-a-real-binary-xyz", [])

    // The spawn error event fires asynchronously; give it a turn to arrive.
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(spawned.error).toBeInstanceOf(Error)
  })
})
