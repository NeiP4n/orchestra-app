import { Cause, Data, Deferred, Effect, PlatformError, Schema } from "effect"

/** Reasons are constructed by the registration watcher, never decoded from a registration file. */
export type ManagedStopReason =
  | { readonly _tag: "OwnershipLost" }
  | {
      readonly _tag: "RegistrationCheckFailed"
      readonly cause: Cause.Cause<unknown>
      readonly diagnostic?: {
        readonly serviceId: string
        readonly path: string
        readonly operation: "read-registration"
      }
    }

export type RequestManagedStop = (reason: ManagedStopReason) => Effect.Effect<boolean>

export class OwnershipLost extends Data.TaggedError("ManagedOwnershipLost") {
  readonly reason = "ownership-lost" as const
}

// Registration check failures intentionally have outward Fail(RegistrationCheckError).
// Original Cause identity (including mixed interrupts) is retained only internally.
// This keeps raw decoded registration values out of error rendering; mixed faults remain nonzero.
const originals = new WeakMap<RegistrationCheckError, Cause.Cause<unknown>>()
export class RegistrationCheckError extends Data.TaggedError("ManagedRegistrationCheckError")<{
  readonly kind: string
  readonly serviceId: string
  readonly path: string
  readonly operation: "read-registration"
}> {
  override get message() {
    return JSON.stringify({ kind: this.kind, serviceId: this.serviceId, operation: this.operation, path: this.path })
  }
}
export function originalRegistrationCause(error: RegistrationCheckError): Cause.Cause<unknown> | undefined {
  return originals.get(error)
}
export function registrationCheckError(
  reason: Extract<ManagedStopReason, { _tag: "RegistrationCheckFailed" }>,
): RegistrationCheckError {
  const fail = reason.cause.reasons.find(Cause.isFailReason)?.error
  let kind = "RegistrationCheckFailed"
  if (Schema.isSchemaError(fail)) kind = "SchemaError"
  else if (fail instanceof PlatformError.PlatformError) {
    const tag = fail.reason._tag
    kind = ["NotFound", "PermissionDenied", "BadArgument", "Unknown", "Busy"].includes(tag) ? tag : "PlatformError"
  }
  const error = new RegistrationCheckError({
    kind,
    serviceId: reason.diagnostic?.serviceId ?? "managed",
    path: reason.diagnostic?.path ?? "registration",
    operation: "read-registration",
  })
  originals.set(error, reason.cause)
  return error
}

/** The Deferred accepts exactly the first request; duplicate or late requests cannot replace it. */
export const makeManagedStop = Effect.gen(function* () {
  const reason = yield* Deferred.make<ManagedStopReason>()
  const request: RequestManagedStop = (value) => Deferred.succeed(reason, value)
  const awaitStop = Deferred.await(reason).pipe(
    Effect.flatMap((value) =>
      Effect.fail<OwnershipLost | RegistrationCheckError>(
        value._tag === "OwnershipLost" ? new OwnershipLost() : registrationCheckError(value),
      ),
    ),
  )
  return { request, awaitStop }
})

/** Never discard concurrent interruption, defect, or scope/layer-finalization failure. */
export function isOnlyOwnershipLost(cause: Cause.Cause<unknown>): boolean {
  if (cause.reasons.length !== 1) return false
  const reason = cause.reasons[0]
  return Cause.isFailReason(reason) && reason.error instanceof OwnershipLost && reason.error.reason === "ownership-lost"
}
