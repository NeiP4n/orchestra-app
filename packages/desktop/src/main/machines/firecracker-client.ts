// Firecracker API client over a Unix socket.
// The requester is injected so tests can run against a fake socket server
// instead of a real Firecracker binary: the client sends the configuration
// requests from firecrackerApiRequests in order, and any non-2xx response
// is an error, never a silent boot. The real requester below uses
// node:http over the socket path; it never uses TCP, so the API is only
// reachable from the local machine that owns the socket.

import { request as httpRequest } from "node:http"
import {
  firecrackerApiRequests,
  firecrackerSocketPath,
  type FirecrackerApiBody,
  type FirecrackerAssets,
} from "./firecracker"
import type { Machine } from "./store"

export interface FirecrackerResponse {
  status: number
  body: string
}

export type FirecrackerRequester = (
  socketPath: string,
  method: "PUT",
  path: string,
  body: FirecrackerApiBody,
) => Promise<FirecrackerResponse>

export function createUnixSocketRequester(): FirecrackerRequester {
  return (socketPath, method, path, body) =>
    new Promise<FirecrackerResponse>((resolve, reject) => {
      const payload = JSON.stringify(body)

      const req = httpRequest(
        {
          socketPath,
          method,
          path,
          headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
        },
        (res) => {
          const chunks: Buffer[] = []

          res.on("data", (chunk: Buffer) => chunks.push(chunk))
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }))
        },
      )

      req.on("error", reject)
      req.write(payload)
      req.end()
    })
}

export async function startFirecrackerVM(
  requester: FirecrackerRequester,
  machine: Machine,
  assets: FirecrackerAssets,
): Promise<void> {
  const socketPath = firecrackerSocketPath(machine.id)

  for (const apiRequest of firecrackerApiRequests(machine, assets)) {
    const response = await requester(socketPath, apiRequest.method, apiRequest.path, apiRequest.body)

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Firecracker ${apiRequest.method} ${apiRequest.path} failed with status ${response.status}`)
    }
  }
}
