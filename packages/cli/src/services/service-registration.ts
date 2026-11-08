export * as ServiceRegistration from "./service-registration"

import { Service, type Info } from "@orchestra/client/effect/service"
import path from "node:path"
import { Cause, Effect, FileSystem, Schedule, Schema } from "effect"
import { HttpServer } from "effect/unstable/http"
import type { RequestManagedStop } from "@orchestra/server/managed-stop"
import { ORCHESTRA_VERSION } from "../version"

const infoJson = Schema.fromJsonString(Service.Info)
const encodeInfo = Schema.encodeEffect(infoJson)
const decodeInfo = Schema.decodeUnknownEffect(infoJson)

type RegistrationOptions = {
  readonly address: HttpServer.Address
  readonly password: string
  readonly id: string
  readonly file: string
} & (
  | { readonly requestStop: RequestManagedStop; readonly shutdown?: never }
  | { readonly shutdown: Effect.Effect<void>; readonly requestStop?: never }
)

export const register = Effect.fnUntraced(function* (options: RegistrationOptions) {
  const fs = yield* FileSystem.FileSystem
  const temp = options.file + "." + options.id + ".tmp"
  yield* fs.makeDirectory(path.dirname(options.file), { recursive: true })
  const info = {
    id: options.id,
    version: ORCHESTRA_VERSION,
    // Advertise a connectable URL. A service opened to the LAN binds the
    // wildcard address, and formatAddress reports it verbatim
    // (http://0.0.0.0:port) — but 0.0.0.0 is a bind address, not a connect
    // address: Windows clients refuse to connect to it, so local discovery
    // never saw this healthy service and ensure() timed out spawning
    // contenders. Loopback reaches the same listener; LAN devices do not
    // read this local file.
    url: HttpServer.formatAddress(options.address)
      .replace("://0.0.0.0", "://127.0.0.1")
      .replace("://[::]", "://127.0.0.1"),
    pid: process.pid,
    password: options.password,
  }
  const encoded = yield* encodeInfo(info)
  const current = fs.readFileString(options.file).pipe(Effect.flatMap(decodeInfo))
  const owns = (found: Info) =>
    found.id === info.id &&
    found.version === info.version &&
    found.url === info.url &&
    found.pid === info.pid &&
    found.password === info.password
  yield* fs.writeFileString(temp, encoded, { mode: 0o600 }).pipe(Effect.andThen(fs.rename(temp, options.file)))
  // Turn only read/decode failures into a reason. Scope cancellation must remain cancellation.
  const check = current.pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause) ? Effect.failCause(cause) : Effect.succeed({ checkFailure: cause } as const),
    ),
  )
  yield* check.pipe(
    Effect.repeat({
      until: (found) => "checkFailure" in found || !owns(found),
      schedule: Schedule.spaced("5 seconds"),
    }),
    Effect.flatMap((found) => {
      const reason =
        "checkFailure" in found
          ? {
              _tag: "RegistrationCheckFailed" as const,
              cause: found.checkFailure,
              diagnostic: { serviceId: options.id, path: options.file, operation: "read-registration" as const },
            }
          : { _tag: "OwnershipLost" as const }
      const stop = options.requestStop ? options.requestStop(reason).pipe(Effect.asVoid) : options.shutdown!
      return Effect.logWarning("managed service registration stopping", {
        reason: reason._tag,
        serviceID: options.id,
      }).pipe(Effect.andThen(stop))
    }),
    Effect.forkScoped,
  )
  return current.pipe(
    Effect.flatMap((found) => (owns(found) ? fs.remove(options.file) : Effect.void)),
    Effect.ignore,
  )
})
