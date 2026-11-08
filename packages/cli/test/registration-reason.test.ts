import { expect, test } from "bun:test"
import { NodeFileSystem } from "@effect/platform-node"
import { Cause, Deferred, Effect, FileSystem, PlatformError } from "effect"
import { ServiceRegistration } from "../src/services/service-registration"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"

// Separate callback-contract proposal: no change to the lifecycle product draft.
for (const fault of ["missing", "malformed", "EACCES"] as const) {
  const probe = fault === "EACCES" && process.platform === "win32" ? test.skip : test
  probe(
    `registration check ${fault} is not ownership loss${fault === "EACCES" ? " (POSIX proof only)" : ""}`,
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "orchestra-check-fault-"))
      const file = path.join(root, "registration.json")
      let conceded = false
      let failureCause = ""
      try {
        await Effect.runPromise(
          Effect.gen(function* () {
            const observed = yield* Deferred.make<void>()
            yield* ServiceRegistration.register({
              address: { _tag: "TcpAddress", hostname: "127.0.0.1", port: 4321 },
              password: "dummy",
              id: "dummy",
              file,
              requestStop: (reason) =>
                Effect.sync(() => {
                  conceded = reason._tag === "OwnershipLost"
                  if (reason._tag === "RegistrationCheckFailed") failureCause = Cause.pretty(reason.cause)
                }).pipe(Effect.andThen(Deferred.succeed(observed, undefined))),
            })
            if (fault === "missing") yield* Effect.promise(() => fs.rm(file))
            else if (fault === "malformed") yield* Effect.promise(() => fs.writeFile(file, "not JSON"))
            else yield* Effect.promise(() => fs.chmod(file, 0))
            yield* Deferred.await(observed)
          }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
        )
        console.log(JSON.stringify({ fault, conceded, failureCause }))
        expect(conceded).toBe(false)
        expect(failureCause.length).toBeGreaterThan(0)
        if (fault === "malformed") expect(await fs.readFile(file, "utf8")).toBe("not JSON")
        else if (fault === "missing")
          expect(
            await fs.stat(file).then(
              () => true,
              () => false,
            ),
          ).toBe(false)
        else expect(failureCause).toContain("PermissionDenied")
      } finally {
        await fs.rm(root, { recursive: true, force: true })
      }
    },
    15000,
  )
}

test("watcher scope cancellation is not a registration-check failure", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "orchestra-watch-cancel-"))
  let callbacks = 0
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* ServiceRegistration.register({
          address: { _tag: "TcpAddress", hostname: "127.0.0.1", port: 4321 },
          password: "dummy",
          id: "dummy",
          file: path.join(root, "registration.json"),
          requestStop: () =>
            Effect.sync(() => {
              callbacks++
              return true
            }),
        })
      }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
    )
    expect(callbacks).toBe(0)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("mixed read fault plus interrupt preserves the fault through the callback", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "orchestra-mixed-check-"))
  const file = path.join(root, "registration.json")
  const fault = new PlatformError.PlatformError(
    new PlatformError.SystemError({
      _tag: "Unknown",
      module: "FileSystem",
      method: "readFileString",
      description: "dummy mixed read fault",
    }),
  )
  const original = Cause.fromReasons([...Cause.fail(fault).reasons, ...Cause.interrupt(123).reasons])
  let received: Cause.Cause<unknown> | undefined
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const native = yield* FileSystem.FileSystem
        const readExited = yield* Deferred.make<void>()
        yield* ServiceRegistration.register({
          address: { _tag: "TcpAddress", hostname: "127.0.0.1", port: 4321 },
          password: "dummy",
          id: "dummy",
          file,
          requestStop: (reason) =>
            Effect.sync(() => {
              if (reason._tag === "RegistrationCheckFailed") received = reason.cause
              return true
            }),
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...native,
            readFileString: () =>
              Effect.failCause(original).pipe(Effect.onExit(() => Deferred.succeed(readExited, undefined))),
          }),
        )
        yield* Deferred.await(readExited)
        yield* Effect.yieldNow
      }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
    )
    expect(received).toBe(original)
    expect(received?.reasons.some(Cause.isFailReason)).toBe(true)
    expect(received?.reasons.some(Cause.isInterruptReason)).toBe(true)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
