import { FileSystem } from "@orchestra/core/filesystem"
import { Location } from "@orchestra/core/location"
import { LocationServiceMap } from "@orchestra/core/location-services"
import { AbsolutePath } from "@orchestra/core/schema"
import { Session } from "@orchestra/core/session"
import { LocationNotFoundError, InvalidRequestError } from "@orchestra/protocol/errors"
import { Cause, Effect, Layer, Schema } from "effect"
import { HttpServerRequest } from "effect/unstable/http"
import { HttpApiMiddleware } from "effect/unstable/httpapi"
import { missingSession } from "./handlers/session-error"

export type LocationServices = Layer.Success<ReturnType<(typeof LocationServiceMap.Service)["get"]>>

export class LocationMiddleware extends HttpApiMiddleware.Service<LocationMiddleware, { provides: LocationServices }>()(
  "@orchestra/HttpApiLocation",
  { error: [LocationNotFoundError] },
) {}

export function locationErrors<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return effect.pipe(
    Effect.catchIf(
      (error): error is Extract<E, FileSystem.DirectoryNotFoundError> =>
        error instanceof FileSystem.DirectoryNotFoundError,
      (error) =>
        Effect.fail(
          new LocationNotFoundError({
            location: { directory: error.directory },
            message: `Location not found: ${error.directory}`,
          }),
        ),
    ),
  )
}

export function response<A, E, R>(data: Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    const location = yield* Location.Service
    return {
      location: new Location.Info({
        directory: location.directory,
        project: location.project,
      }),
      data: yield* data,
    }
  })
}

const decodeSessionID = Schema.decodeUnknownEffect(Session.ID)

export const sessionInfo = Effect.fnUntraced(function* (sessions: Session.Interface, sessionID: unknown) {
  const id = yield* decodeSessionID(sessionID).pipe(
    Effect.mapError(() => new InvalidRequestError({ message: "Invalid session ID", field: "sessionID" })),
  )
  return yield* sessions.get(id).pipe(Effect.catchTag("Session.NotFoundError", missingSession))
})

export const LOCATION_DIRECTORY_HEADER = "x-orchestra-directory"
export const LEGACY_LOCATION_DIRECTORY_HEADER = "x-opencode-directory"

export function requestRef(request: HttpServerRequest.HttpServerRequest): Location.Ref {
  const query = new URL(request.url, "http://localhost").searchParams
  const canonical = request.headers[LOCATION_DIRECTORY_HEADER]
  const legacy = request.headers[LEGACY_LOCATION_DIRECTORY_HEADER]
  const header = canonical && canonical.trim() !== "" ? canonical : legacy
  const directory =
    query.get("location[directory]") ||
    (header ? decode(header) : process.cwd())
  return Location.Ref.make({
    directory: AbsolutePath.make(directory),
  })
}

function decode(input: string) {
  try {
    return decodeURIComponent(input)
  } catch {
    return input
  }
}

export const layer = Layer.effect(
  LocationMiddleware,
  Effect.gen(function* () {
    const locations = yield* LocationServiceMap.Service
    return LocationMiddleware.of((effect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const ref = requestRef(request)
        return yield* effect.pipe(
          Effect.provide(locations.get(ref)),
          locationErrors,
          // A defect here (a location service dying while it builds or
          // serves) reaches the client as a bare 500 with no body, which
          // made real failures undiagnosable from the UI ("Session location
          // unavailable / UnexpectedStatus: 500" for every directory).
          // Log the full cause server-side, where the failing service is
          // named; typed errors are control flow and stay unlogged. This
          // only observes the failure — it changes no error the client sees.
          Effect.onError((cause) =>
            cause.reasons.some((reason) => Cause.isDieReason(reason))
              ? Effect.logError("Location request failed with a defect", { cause, directory: ref.directory })
              : Effect.void,
          ),
        )
      }),
    )
  }),
)
