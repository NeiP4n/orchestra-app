import { expect, test } from "bun:test"
import { createServer } from "node:net"
import { startHttpBridge } from "@orchestra/core/warp-http-bridge"

// Setting up the WARP route runs again on every enable and every automatic IP change.
test("starting the bridge again in the same process keeps the running one", async () => {
  const port = 41000 + Math.floor(Math.random() * 2000)
  expect(await startHttpBridge(40000, port)).toBe("started")
  expect(await startHttpBridge(40000, port)).toBe("running")
})

test("a port held by another process is reported instead of failing", async () => {
  const other = createServer()
  await new Promise<void>((resolve) => other.listen(0, "127.0.0.1", resolve))
  const address = other.address()
  if (!address || typeof address === "string") throw new Error("no port")
  expect(await startHttpBridge(40000, address.port)).toBe("taken")
  other.close()
})
