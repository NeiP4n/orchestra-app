import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"

const require = createRequire(new URL("../packages/app/package.json", import.meta.url))
const { chromium } = require("@playwright/test")
const entry = fileURLToPath(new URL("../packages/gui-extensions/src/microsoft-office/worker-rpc.ts", import.meta.url))
const build = await Bun.build({ entrypoints: [entry], target: "browser" })
assert.equal(build.success, true, "worker RPC must build for browsers")
const module = await build.outputs[0].text()
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    return new URL(request.url).pathname === "/rpc.js"
      ? new Response(module, { headers: { "Content-Type": "text/javascript" } })
      : new Response("<!doctype html><title>Office worker RPC regression</title>", {
          headers: { "Content-Type": "text/html" },
        })
  },
})
const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
})
try {
  const page = await browser.newPage()
  await page.goto(server.url.href)
  const result = await page.evaluate(async () => {
    const url = new URL("/rpc.js", location.href).href
    const { createWorkerClient } = await import(url)
    const source = `import { serveWorker, Transfer } from ${JSON.stringify(url)};
      const ran = [];
      serveWorker({
        echo: value => { ran.push("echo"); return value },
        bytes: value => new Transfer(value, [value]),
        bitmap: async () => {
          const canvas = new OffscreenCanvas(2, 3);
          canvas.getContext("2d").fillRect(0, 0, 2, 3);
          const bitmap = canvas.transferToImageBitmap();
          return new Transfer(bitmap, [bitmap]);
        },
        log: () => ran,
      });`
    const blob = URL.createObjectURL(new Blob([source], { type: "text/javascript" }))
    const client = createWorkerClient(new Worker(blob, { type: "module" }))
    try {
      const refused = []
      for (const method of ["constructor", "toString", "__defineGetter__"]) {
        try {
          await client.call(method, "not registered")
          throw new Error(`Inherited method ran: ${method}`)
        } catch (error) {
          if (error.message !== `Unknown method ${method}`) throw error
          refused.push(method)
        }
      }
      const echo = await client.call("echo", "browser round trip")
      const bytes = new Uint8Array([7, 8, 9]).buffer
      const moved = client.call("bytes", bytes, { transfer: [bytes] })
      const detached = bytes.byteLength === 0
      const returned = Array.from(new Uint8Array(await moved))
      const bitmap = await client.call("bitmap", undefined)
      const size = [bitmap.width, bitmap.height]
      bitmap.close()
      const closed = bitmap.width === 0
      const ran = await client.call("log", undefined)
      return { refused, echo, detached, returned, size, closed, ran }
    } finally {
      client.close()
      URL.revokeObjectURL(blob)
    }
  })
  assert.deepEqual(result, {
    refused: ["constructor", "toString", "__defineGetter__"],
    echo: "browser round trip",
    detached: true,
    returned: [7, 8, 9],
    size: [2, 3],
    closed: true,
    ran: ["echo"],
  })
  console.log(
    "PASS: Chromium real Worker rejects inherited methods; own calls, transferred buffers and ImageBitmap survive",
  )
} finally {
  await browser.close()
  server.stop(true)
}
