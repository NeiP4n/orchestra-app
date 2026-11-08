import { strict as assert } from "node:assert"
import net from "node:net"
import { NodeServices } from "@effect/platform-node"
import { Cause, Effect, Exit, Runtime } from "effect"
import { HttpServer } from "effect/unstable/http"
import { ServerProcess } from "../../../server/src/process"

async function assertPortRefused(base: string) {
  const url = new URL(base)
  await new Promise<void>((resolve, reject) => {
    const socket = net.createConnection({ host: url.hostname, port: Number(url.port) })
    socket.setTimeout(1500)
    socket.once("connect", () => {
      socket.destroy()
      reject(new Error("port is still accepting"))
    })
    socket.once("timeout", () => {
      socket.destroy()
      reject(new Error("port probe timeout"))
    })
    socket.once("error", (error: NodeJS.ErrnoException) => {
      socket.destroy()
      if (error.code === "ECONNREFUSED" || error.code === "ECONNRESET") resolve()
      else reject(error)
    })
  })
}

async function noLifecycle() {
  let base = ""
  await Effect.runPromise(
    Effect.gen(function* () {
      const server = yield* ServerProcess.start({
        hostname: "127.0.0.1",
        port: 0,
        password: "dummy",
        database: { path: ":memory:" },
        models: { fetch: false },
        config: { project: false, content: "{}" },
        fs: { filewatcher: false, fff: false },
        backup: { enabled: false },
      })
      base = HttpServer.formatAddress(server.address)
      const response = yield* Effect.promise(() =>
        fetch(new URL("/api/info", base), {
          signal: AbortSignal.timeout(3000),
          headers: { authorization: "Basic " + btoa("opencode:dummy") },
        }),
      )
      assert.equal(response.status, 200)
      yield* Effect.promise(() => response.arrayBuffer())
      const shutdown = yield* server.shutdown.pipe(Effect.forkScoped)
      yield* Effect.yieldNow
      assert.equal(shutdown.pollUnsafe(), undefined)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )
  await assertPortRefused(base)
}

async function legacy() {
  const exit = await Effect.runPromise(
    Effect.gen(function* () {
      return yield* Effect.exit(
        ServerProcess.start(
          {
            hostname: "127.0.0.1",
            port: 0,
            password: "dummy",
            database: { path: ":memory:" },
            models: { fetch: false },
            fs: { filewatcher: false, fff: false },
          },
          { onListen: (_address, shutdown) => shutdown.pipe(Effect.as(Effect.void)) },
        ),
      )
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )
  const codes: number[] = []
  Runtime.defaultTeardown(exit, (code) => codes.push(code))
  assert.deepEqual(codes, [130])
  assert.equal(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause), true)
}

await noLifecycle()
console.log("PASS no-lifecycle")
await legacy()
console.log("PASS legacy")

async function legacyPostBoot() {
  let base = ""
  const exit = await Effect.runPromise(
    Effect.gen(function* () {
      let request: Effect.Effect<void> | undefined
      const server = yield* ServerProcess.start(
        {
          hostname: "127.0.0.1",
          port: 0,
          password: "dummy",
          database: { path: ":memory:" },
          models: { fetch: false },
          config: { project: false, content: "{}" },
          fs: { filewatcher: false, fff: false },
          backup: { enabled: false },
        },
        {
          onListen: (address, shutdown) =>
            Effect.sync(() => {
              base = HttpServer.formatAddress(address)
              request = shutdown
              return Effect.void
            }),
        },
      )
      // start returned through raceFirst before requesting the legacy shutdown.
      yield* request!
      yield* server.shutdown
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer), Effect.exit),
  )
  assert.equal(Exit.isSuccess(exit), true)
  await assertPortRefused(base)
}
await legacyPostBoot()
console.log("PASS legacy-postboot")
