export * as ServiceClaim from "./service-claim"

import { Duration, Effect, FileSystem } from "effect"
import path from "node:path"

/**
 * Startup ownership for the managed service.
 *
 * The client can spawn two service contenders for one ensure() attempt, and several
 * clients can race. Without an owner, every contender that finishes starting overwrites
 * the registration file; the previous owner's registration self-check then shuts it down,
 * the next contender overwrites the survivor in turn, and no service lives long enough
 * for the client to discover it — startup ends in a timeout. The first contender to
 * create the claim file owns startup; the others wait for it to register and then yield
 * to it through their incumbent check. This mirrors the owner-claim protocol the client
 * fixture services already follow (`registration + ".owner"`, created exclusively).
 */

export const claimFile = (registration: string) => registration + ".owner"

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** The pid holding the claim, or undefined when no claim exists or its content is unusable. */
export const holder = (file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const text = yield* fs.readFileString(claimFile(file)).pipe(Effect.orElseSucceed(() => undefined))
    if (text === undefined) return undefined
    const pid = Number(text.trim())
    return Number.isInteger(pid) && pid > 0 ? pid : undefined
  })

/** Atomically claim startup ownership. Returns false when another process holds the claim. */
export const claim = (file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    yield* fs.makeDirectory(path.dirname(file), { recursive: true }).pipe(Effect.ignore)
    return yield* fs.writeFileString(claimFile(file), String(process.pid), { flag: "wx" }).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    )
  })

/** Remove the claim when it still names the given pid. */
const removeIfNames = (file: string, pid: number) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    if ((yield* holder(file)) !== pid) return
    yield* fs.remove(claimFile(file)).pipe(Effect.ignore)
  })

/** Remove the claim when it still names this process. */
export const release = (file: string) => removeIfNames(file, process.pid)

export interface AcquireOptions<E, R> {
  /** The registration file the claim sits beside. */
  readonly file: string
  /** Whether a compatible incumbent service is now visible (the holder finished starting). */
  readonly incumbent?: Effect.Effect<boolean, E, R>
  /** How long to wait for a live holder before deciding. Defaults to 30 seconds. */
  readonly timeout?: Duration.Duration
  /** Delay between checks while waiting. Defaults to 250 millis. */
  readonly poll?: Duration.Duration
}

/**
 * Take startup ownership, waiting for a live holder when one exists.
 *
 * Returns "claimed" when this process owns startup (the caller must `release` on exit)
 * and "yield" when a holder finished starting — its incumbent is visible — or when a
 * live holder kept the claim past the timeout with a registration in place, in which
 * case the client resolves the service through discovery as usual. A holder whose pid
 * died leaves a stale claim that the next waiter reclaims. A holder that stays alive
 * for the whole timeout without producing any registration is wedged before it could
 * register; its claim is taken over so this attempt can still start a service, and if
 * the holder ever does finish, ownership resolves through the registration self-check
 * exactly as it did before claims existed.
 */
export const acquire = <E, R>(
  options: AcquireOptions<E, R>,
): Effect.Effect<"claimed" | "yield", E, R | FileSystem.FileSystem> =>
  Effect.gen(function* () {
    if (yield* claim(options.file)) return "claimed" as const
    const fs = yield* FileSystem.FileSystem
    const deadline = Date.now() + Duration.toMillis(options.timeout ?? "30 seconds")
    const poll = options.poll ?? "250 millis"
    while (true) {
      const pid = yield* holder(options.file)
      if (pid === undefined) {
        // The claim vanished or is mid-write; a fresh claim decides.
        if (yield* claim(options.file)) return "claimed" as const
      } else if (!alive(pid)) {
        yield* removeIfNames(options.file, pid)
        if (yield* claim(options.file)) return "claimed" as const
      } else {
        if (options.incumbent !== undefined && (yield* options.incumbent)) return "yield" as const
        if (Date.now() >= deadline) {
          // A failed existence check counts as "registered": never steal on uncertainty.
          const registered = yield* fs.exists(options.file).pipe(Effect.orElseSucceed(() => true))
          if (!registered) {
            yield* removeIfNames(options.file, pid)
            if (yield* claim(options.file)) return "claimed" as const
          }
          return "yield" as const
        }
      }
      yield* Effect.sleep(poll)
    }
  })
