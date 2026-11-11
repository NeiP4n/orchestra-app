import { expect, test } from "bun:test"
import { Cause, Effect, Exit } from "effect"
import { HttpClient } from "effect/unstable/http"
import { authorize } from "@orchestra/core/plugin/provider/google-antigravity"
import { AntigravityOAuthConfigurationError, requireAntigravityClientSecret } from "@orchestra/core/plugin/provider/google-antigravity-env"
import { Integration } from "@orchestra/core/integration"

test("native OAuth preflight preserves the typed configuration error before network or callback startup", async () => {
  const previous = process.env.ORCHESTRA_ANTIGRAVITY_CLIENT_SECRET
  delete process.env.ORCHESTRA_ANTIGRAVITY_CLIENT_SECRET
  try {
    const http = new Proxy({}, { get() { throw new Error("network must not be used") } }) as HttpClient.HttpClient
    const exit = await Effect.runPromise(Effect.scoped(authorize(http)).pipe(Effect.exit))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isSuccess(exit)) throw new Error("Expected preflight failure")
    expect(Cause.hasDies(exit.cause)).toBe(false)
    const error = Cause.squash(exit.cause)
    expect(error).toBeInstanceOf(AntigravityOAuthConfigurationError)
    const publicError = new Integration.AuthorizationError({ cause: error })
    expect(publicError.message).toContain("ORCHESTRA_ANTIGRAVITY_CLIENT_SECRET")
    expect(publicError.message).not.toContain("An error occurred in Effect.try")
  } finally {
    if (previous === undefined) delete process.env.ORCHESTRA_ANTIGRAVITY_CLIENT_SECRET
    else process.env.ORCHESTRA_ANTIGRAVITY_CLIENT_SECRET = previous
  }
})

test("native preflight does not embed secret values in configuration errors", () => {
  expect(requireAntigravityClientSecret({ ORCHESTRA_ANTIGRAVITY_CLIENT_SECRET: "private-config-canary" })).toBe("private-config-canary")
  expect(new AntigravityOAuthConfigurationError().message).not.toContain("private-config-canary")
})
