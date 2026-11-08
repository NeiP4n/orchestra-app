// Imported only after the wrapper has isolated all environment roots and cwd.
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Cause, Deferred, Effect, Exit } from "effect"
import { strict as assert } from "node:assert"
import { ServerProcess } from "@orchestra/server/process"
import type { RequestManagedStop } from "@orchestra/server/managed-stop"

const cleanupFault = process.argv[2] === "cleanup-fault"
const bootError = new Error("DUMMY_CONCURRENT_BOOT_FAULT")
const cleanupError = new Error("DUMMY_FAILED_BOOT_CLEANUP_FAULT")
const program = Effect.gen(function* () {
  const bootStarted = yield* Deferred.make<void>()
  let request!: RequestManagedStop
  return yield* ServerProcess.start(
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
      onManagedListen: (_, stop) =>
        Effect.gen(function* () {
          request = stop
          // This fiber is already runnable when beforeManagedBoot signals and fails.
          yield* Deferred.await(bootStarted).pipe(Effect.andThen(request({ _tag: "OwnershipLost" })), Effect.forkScoped)
          return cleanupFault ? Effect.die(cleanupError) : Effect.void
        }),
      beforeManagedBoot: Deferred.succeed(bootStarted, undefined).pipe(Effect.andThen(Effect.fail(bootError))),
    },
  )
}).pipe(
  Effect.scoped,
  Effect.provide(NodeServices.layer),
  Effect.exit,
  Effect.flatMap((exit) => {
    assert.ok(Exit.isFailure(exit))
    if (Exit.isFailure(exit)) {
      const errors = exit.cause.reasons.map((reason) =>
        Cause.isFailReason(reason) ? reason.error : Cause.isDieReason(reason) ? reason.defect : undefined,
      )
      assert.ok(errors.includes(bootError), "original boot error identity must remain")
      if (cleanupFault)
        assert.ok(errors.includes(cleanupError), "cleanup fault must remain alongside original boot fault")
      console.log(
        JSON.stringify({
          cleanupFault,
          originalBootIdentity: errors.includes(bootError),
          cleanupIdentity: errors.includes(cleanupError),
          cause: Cause.pretty(exit.cause),
        }),
      )
      return Effect.failCause(exit.cause)
    }
    return Effect.void
  }),
)
NodeRuntime.runMain(program)
