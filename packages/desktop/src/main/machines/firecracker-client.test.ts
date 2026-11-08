import { createServer } from "node:http"
import { rm } from "node:fs/promises"
import { describe, expect, test } from "bun:test"
import { createUnixSocketRequester, startFirecrackerVM, type FirecrackerRequester } from "./firecracker-client"
import { firecrackerSocketPath } from "./firecracker"
import type { Machine } from "./store"

const machine: Machine = {
  id: "fc-test",
  name: "ai-pc",
  backend: "firecracker",
  cpu: 2,
  memoryMb: 2048,
  diskGb: 20,
  network: false,
  status: "stopped",
  createdAt: 0,
}

const assets = {
  kernelImagePath: "/var/lib/orchestra/vmlinux",
  rootfsPath: "/var/lib/orchestra/rootfs.ext4",
}

const expectedOrder = ["PUT /machine-config", "PUT /boot-source", "PUT /drives/rootfs", "PUT /actions"]

describe("firecracker client", () => {
  // Portable: the injected requester records the same order the real client
  // would send, no socket needed.
  test("sends configuration in order", async () => {
    const ordered: string[] = []

    const recording: FirecrackerRequester = async (_socket, method, path) => {
      ordered.push(`${method} ${path}`)

      return { status: 204, body: "" }
    }

    await startFirecrackerVM(recording, machine, assets)

    expect(ordered).toEqual(expectedOrder)
  })

  // The Firecracker backend is Linux-only, so the real transport (HTTP over
  // a unix socket) is exercised on Linux alone; unix sockets themselves work
  // on other OSes. The socket path derivation is covered by
  // firecracker.test.ts on every OS.
  test.skipIf(process.platform !== "linux")("delivers configuration over the real unix socket transport", async () => {
    // A unique machine id keeps the derived socket path collision-free
    // between concurrent test runs; firecrackerSocketPath sanitizes it.
    const unique = { ...machine, id: `fc-test-${process.pid}-${Date.now()}` }
    const socketPath = firecrackerSocketPath(unique.id)
    const seen: string[] = []
    const server = createServer((req, res) => {
      seen.push(`${req.method} ${req.url}`)
      res.writeHead(204)
      res.end()
    })
    const failed = Promise.withResolvers<never>()
    server.on("error", (error: Error) => failed.reject(error))

    await Promise.race([new Promise<void>((resolve) => server.listen(socketPath, resolve)), failed.promise])

    try {
      await startFirecrackerVM(createUnixSocketRequester(), unique, assets)

      expect(seen).toEqual(expectedOrder)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(socketPath, { force: true })
    }
  })

  test("a non-2xx response fails the start instead of reporting a boot", async () => {
    const failing: FirecrackerRequester = async () => ({ status: 400, body: "bad request" })

    await expect(startFirecrackerVM(failing, machine, assets)).rejects.toThrow(
      "Firecracker PUT /machine-config failed with status 400",
    )
  })
})
