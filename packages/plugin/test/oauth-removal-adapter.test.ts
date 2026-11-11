import { expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import { Credential } from "@orchestra/schema/credential"
import { Integration } from "@orchestra/schema/integration"
import { fromPromise } from "../src/promise/adapter.ts"
import type { Context } from "../src/effect/plugin.ts"
import type { IntegrationOAuthMethodRegistration } from "../src/effect/integration.ts"

test("Promise OAuth removal keeps its credential, ID and refusal through the adapter", async () => {
  let registered: IntegrationOAuthMethodRegistration | undefined
  const calls: string[] = []
  let refuse = false
  // Unused domains are inert. Only integration.transform is exercised here.
  const inert: unknown = new Proxy(() => undefined, { get: () => inert })
  const host = new Proxy({}, {
    get: (_target, key) => key === "integration" ? new Proxy({}, {
      get: (_integration, method) => method === "transform" ? (callback: (editor: unknown) => void) => Effect.sync(() => {
        callback({ method: { update: (input: IntegrationOAuthMethodRegistration) => { registered = input } } })
        return { dispose: Effect.void }
      }) : inert,
    }) : inert,
  }) as Context
  const definition = fromPromise({ id: "removal-adapter-test", async setup(ctx) {
    await ctx.integration.transform(editor => editor.method.update({
      integrationID: "google", method: { id: "antigravity", type: "oauth", label: "Test OAuth" },
      async authorize() { throw new Error("Not used") },
      async remove(value, id) {
        expect(value.refresh).toBe("fixture-refresh")
        calls.push(id)
        if (refuse) throw new Error("fixture refusal")
      },
    }))
  } })
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    yield* definition.effect(host)
    expect(registered?.remove).toBeFunction()
    const value = Credential.OAuth.make({ type: "oauth", methodID: Integration.MethodID.make("antigravity"), access: "fixture-access", refresh: "fixture-refresh", expires: 1 })
    yield* registered!.remove!(value, "cred_first")
    refuse = true
    expect(Exit.isFailure(yield* Effect.exit(registered!.remove!(value, "cred_second")))).toBe(true)
    expect(calls).toEqual(["cred_first", "cred_second"])
  })))
})
