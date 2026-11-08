import { expect, test } from "bun:test"
import { Cause, Effect, Exit, Layer, Runtime } from "effect"
import {
  makeManagedStop,
  OwnershipLost,
  isOnlyOwnershipLost,
  RegistrationCheckError,
  originalRegistrationCause,
} from "../../server/src/managed-stop"

test("first managed stop request wins; duplicate and late requests cannot replace it", async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const stop = yield* makeManagedStop
      const first = yield* stop.request({
        _tag: "RegistrationCheckFailed",
        cause: Cause.fail(new Error("dummy EACCES")),
      })
      const duplicate = yield* stop.request({ _tag: "OwnershipLost" })
      const exit = yield* Effect.exit(stop.awaitStop)
      const late = yield* stop.request({ _tag: "OwnershipLost" })
      return { first, duplicate, late, exit }
    }),
  )
  expect([result.first, result.duplicate, result.late]).toEqual([true, false, false])
  expect(Exit.isFailure(result.exit)).toBe(true)
  if (Exit.isFailure(result.exit)) {
    expect(isOnlyOwnershipLost(result.exit.cause)).toBe(false)
    const error = result.exit.cause.reasons.find(Cause.isFailReason)?.error
    expect(error).toBeInstanceOf(RegistrationCheckError)
    expect(Cause.pretty(originalRegistrationCause(error as RegistrationCheckError)!)).toContain("dummy EACCES")
  }
})

test("ownership request has a typed result, not an interrupt", async () => {
  const exit = await Effect.runPromise(
    Effect.gen(function* () {
      const stop = yield* makeManagedStop
      yield* stop.request({ _tag: "OwnershipLost" })
      return yield* Effect.exit(stop.awaitStop)
    }),
  )
  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isFailure(exit)) {
    expect(isOnlyOwnershipLost(exit.cause)).toBe(true)
    expect(Cause.hasInterruptsOnly(exit.cause)).toBe(false)
  }
})

test("tag-shaped arbitrary values are not trusted ownership outcomes", () => {
  expect(isOnlyOwnershipLost(Cause.fail({ _tag: "ManagedOwnershipLost", reason: "ownership-lost" }))).toBe(false)
  expect(isOnlyOwnershipLost(Cause.fail(new Error("ownership-lost")))).toBe(false)
})

for (const kind of ["defect", "finalizer", "interrupt"] as const) {
  test(`ownership with ${kind} must remain nonzero`, async () => {
    const effect =
      kind === "interrupt"
        ? Effect.failCause(
            Cause.fromReasons([Cause.fail(new OwnershipLost()).reasons[0], ...Cause.interrupt(1).reasons]),
          )
        : kind === "defect"
          ? Effect.failCause(
              Cause.fromReasons([
                ...Cause.fail(new OwnershipLost()).reasons,
                ...Cause.die(new Error("dummy direct defect")).reasons,
              ]),
            )
          : Effect.gen(function* () {
              yield* Effect.addFinalizer(() => Effect.die(new Error(`dummy ${kind}`)))
              return yield* Effect.fail(new OwnershipLost())
            }).pipe(Effect.scoped)
    const exit = await Effect.runPromise(
      Effect.exit(effect).pipe(
        Effect.map((exit) => {
          if (Exit.isFailure(exit) && isOnlyOwnershipLost(exit.cause)) return Exit.void
          return exit
        }),
      ),
    )
    const codes: number[] = []
    Runtime.defaultTeardown(exit, (code) => codes.push(code))
    console.log(JSON.stringify({ kind, codes, cause: Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "success" }))
    expect(codes[0]).not.toBe(0)
  })
}

test("ownership cannot hide a provided-layer finalization failure", async () => {
  const layer = Layer.effectDiscard(Effect.addFinalizer(() => Effect.die(new Error("dummy layer finalizer"))))
  const exit = await Effect.runPromise(
    Effect.fail(new OwnershipLost()).pipe(
      Effect.provide(layer),
      Effect.catchCause((cause) => (isOnlyOwnershipLost(cause) ? Effect.void : Effect.failCause(cause))),
      Effect.exit,
    ),
  )
  const codes: number[] = []
  Runtime.defaultTeardown(exit, (code) => codes.push(code))
  expect(codes).toEqual([1])
  expect(Exit.isFailure(exit) && Cause.pretty(exit.cause).includes("dummy layer finalizer")).toBe(true)
})

for (const code of ["ENOENT", "EACCES", "INVALID_JSON"] as const) {
  test(`deterministic cross-platform check-fault Cause preservation: ${code}`, async () => {
    const fault = { code, path: "dummy/registration.json", detail: "test fault, no registration contents" }
    const original = Cause.fail(fault)
    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const stop = yield* makeManagedStop
        yield* stop.request({ _tag: "RegistrationCheckFailed", cause: original })
        return yield* Effect.exit(stop.awaitStop)
      }),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const error = exit.cause.reasons.find(Cause.isFailReason)?.error
      expect(error).toBeInstanceOf(RegistrationCheckError)
      expect(originalRegistrationCause(error as RegistrationCheckError)).toBe(original)
      expect(isOnlyOwnershipLost(exit.cause)).toBe(false)
    }
  })
}

test("owner-first then fault keeps ownership as the first requested reason", async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const stop = yield* makeManagedStop
      const owner = yield* stop.request({ _tag: "OwnershipLost" })
      const fault = yield* stop.request({
        _tag: "RegistrationCheckFailed",
        cause: Cause.fail(new Error("late dummy fault")),
      })
      return { owner, fault, exit: yield* Effect.exit(stop.awaitStop) }
    }),
  )
  expect([result.owner, result.fault]).toEqual([true, false])
  expect(Exit.isFailure(result.exit) && isOnlyOwnershipLost(result.exit.cause)).toBe(true)
})

test("concurrent requests have exactly one winner", async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const stop = yield* makeManagedStop
      const wins = yield* Effect.all(
        [
          stop.request({ _tag: "OwnershipLost" }),
          stop.request({ _tag: "RegistrationCheckFailed", cause: Cause.fail(new Error("dummy concurrent fault")) }),
        ],
        { concurrency: "unbounded" },
      )
      return { wins, exit: yield* Effect.exit(stop.awaitStop) }
    }),
  )
  expect(result.wins.filter(Boolean)).toHaveLength(1)
  expect(Exit.isFailure(result.exit)).toBe(true)
  if (Exit.isFailure(result.exit)) expect(isOnlyOwnershipLost(result.exit.cause)).toBe(result.wins[0])
})

test("mixed registration fault has safe outward Fail, original Cause identity remains internal", async () => {
  const original = Cause.fromReasons([
    ...Cause.fail(new Error("DUMMY_PRIVATE_REGISTRATION_VALUE")).reasons,
    ...Cause.interrupt(1).reasons,
  ])
  const exit = await Effect.runPromise(
    Effect.gen(function* () {
      const stop = yield* makeManagedStop
      yield* stop.request({
        _tag: "RegistrationCheckFailed",
        cause: original,
        diagnostic: {
          serviceId: "dummy-local-service",
          path: "dummy/trusted-registration.json",
          operation: "read-registration",
        },
      })
      return yield* Effect.exit(stop.awaitStop)
    }),
  )
  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isFailure(exit)) {
    const wrapper = exit.cause.reasons.find(Cause.isFailReason)?.error as RegistrationCheckError
    expect(wrapper).toBeInstanceOf(RegistrationCheckError)
    expect(originalRegistrationCause(wrapper)).toBe(original)
    expect(Cause.hasInterrupts(exit.cause)).toBe(false)
    expect(Cause.hasInterrupts(original)).toBe(true)
    expect(Cause.pretty(exit.cause)).not.toContain("DUMMY_PRIVATE_REGISTRATION_VALUE")
    expect(JSON.stringify(wrapper)).not.toContain("DUMMY_PRIVATE_REGISTRATION_VALUE")
  }
  const codes: number[] = []
  Runtime.defaultTeardown(exit, (code) => codes.push(code))
  expect(codes).toEqual([1])
})
