import { createServer } from "node:http"
import { describe, expect, test } from "bun:test"
import { createUnixSocketRequester, startFirecrackerVM, type FirecrackerRequester } from "./firecracker-client"
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

describe("firecracker client", () => {
  test("sends configuration in order to a fake unix socket server", async () => {
    const seen: string[] = []
    const socketPath = "/tmp/orchestra-test-fc.socket"

    const server = createServer((req, res) => {
      seen.push(`${req.method} ${req.url}`)
      res.writeHead(204)
      res.end()
    })

    await new Promise<void>((resolve) => server.listen(socketPath, resolve))

    try {
      const requester: FirecrackerRequester = async (_path, method, path, body) => {
        // Reuse the real requester against the fake server by rewriting the
        // socket path: the client under test builds its own path, so this
        // test drives the requester directly with the fake socket.
        void _path

        return createUnixSocketRequester()(socketPath, method, path, body)
      }

      // Drive the client logic with a requester that records the same order
      // the real client would send, then verify the fake server saw it.
      const ordered: string[] = []

      const recording: FirecrackerRequester = async (_socket, method, path, body) => {
        ordered.push(`${method} ${path}`)

        return requester(socketPath, method, path, body)
      }

      await startFirecrackerVM(recording, machine, assets)

      expect(ordered).toEqual(["PUT /machine-config", "PUT /boot-source", "PUT /drives/rootfs", "PUT /actions"])
      expect(seen).toEqual(ordered)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  test("a non-2xx response fails the start instead of reporting a boot", async () => {
    const failing: FirecrackerRequester = async () => ({ status: 400, body: "bad request" })

    await expect(startFirecrackerVM(failing, machine, assets)).rejects.toThrow(
      "Firecracker PUT /machine-config failed with status 400",
    )
  })
})
