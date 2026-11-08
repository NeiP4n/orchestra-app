import { strict as assert } from "node:assert"
import { NodeFileSystem } from "@effect/platform-node"
import { Deferred, Effect, Fiber } from "effect"
import fs from "node:fs/promises"
import { constants } from "node:fs"
import os from "node:os"
import path from "node:path"
import { ServiceRegistration } from "../../src/services/service-registration"

// Native FIFO/procfs proof. Windows needs its own pending-read strategy and native runner.
async function pendingRead() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "orchestra-fifo-cancel-"))
  const file = path.join(root, "registration.json")
  let keeper: Awaited<ReturnType<typeof fs.open>> | undefined
  let callbacks = 0
  let descriptorProof = 0
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const registered = yield* Deferred.make<void>()
        const worker = yield* Effect.gen(function* () {
          yield* ServiceRegistration.register({
            address: { _tag: "TcpAddress", hostname: "127.0.0.1", port: 4321 },
            password: "dummy",
            id: "dummy",
            file,
            requestStop: () =>
              Effect.sync(() => {
                callbacks++
                return true
              }),
          })
          yield* Deferred.succeed(registered, undefined)
          yield* Effect.never
        }).pipe(Effect.scoped, Effect.forkScoped)
        yield* Deferred.await(registered)
        yield* Effect.promise(async () => {
          const mkfifo = Bun.spawn(["/usr/bin/mkfifo", file + ".fifo"], { stdout: "ignore", stderr: "pipe" })
          const error = new Response(mkfifo.stderr).text()
          const code = await Promise.race([mkfifo.exited, Bun.sleep(1000).then(() => "timeout")])
          if (code === "timeout") {
            mkfifo.kill("SIGKILL")
            await Promise.race([
              mkfifo.exited,
              Bun.sleep(1000).then(() => {
                throw new Error("mkfifo reap timeout")
              }),
            ])
            throw new Error("mkfifo timeout")
          }
          await Promise.race([
            error,
            Bun.sleep(1000).then(() => {
              throw new Error("mkfifo stderr timeout")
            }),
          ])
          if (code !== 0) throw new Error("mkfifo failed")
          keeper = await fs.open(file + ".fifo", constants.O_RDWR | constants.O_NONBLOCK)
          await fs.rename(file + ".fifo", file)
          const until = Date.now() + 10000
          while (Date.now() < until) {
            const fds = await fs.readdir("/proc/self/fd")
            const targets = await Promise.all(fds.map((fd) => fs.readlink("/proc/self/fd/" + fd).catch(() => "")))
            descriptorProof = targets.filter((target) => target === file).length
            if (descriptorProof >= 2) return
            await Bun.sleep(10)
          }
          throw new Error("did not observe a real second FIFO read descriptor")
        })
        // One descriptor is our RDWR keeper; the second belongs to the watcher's native read.
        const cancellation = yield* Fiber.interrupt(worker).pipe(Effect.forkScoped)
        yield* Effect.yieldNow
        yield* Effect.promise(async () => {
          await keeper?.close()
          keeper = undefined
        })
        yield* Fiber.join(cancellation).pipe(Effect.timeout("2 seconds"))
      }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
    )
    console.log(JSON.stringify({ descriptorProof, callbacks }))
    assert.ok(descriptorProof >= 2)
    assert.equal(callbacks, 0)
  } finally {
    await keeper?.close()
    await fs.rm(root, { recursive: true, force: true })
  }
}
await pendingRead()
