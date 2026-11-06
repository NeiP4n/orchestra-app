import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { SocietyPreflight } from "../src/society-preflight"
import { Credential } from "../src/credential"
import { openSocietyTeam } from "../src/federation"
import { Orchestra } from "../src/orchestra"
import { Orchestra as OrchestraSchema } from "@orchestra/schema/orchestra"
import { SessionID } from "@orchestra/schema/session-id"

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const liveModels = (ids: ReadonlyArray<string>) => async () => json({ data: ids.map((id) => ({ id })) })

const run = (input: Parameters<typeof SocietyPreflight.checkSocietyProvider>[0]) =>
  Effect.runPromise(SocietyPreflight.checkSocietyProvider(input))

describe("SocietyPreflight.checkSocietyProvider (G2-1)", () => {
  test("refuses when no key is stored anywhere", async () => {
    const result = await run({ baseURL: "https://anymodel.ghostly.su/v1", fetchFn: liveModels(["sonnet-5"]) })
    expect(result.status).toBe("failed")
    if (result.status === "failed") {
      expect(result.reason).toBe("no-credential")
      expect(result.message).toContain("No Anymodel API key")
      expect(result.action).toContain("Settings")
    }
  })

  test("treats a blank stored key as no key", async () => {
    const result = await run({
      credentialKey: "   ",
      baseURL: "https://anymodel.ghostly.su/v1",
      fetchFn: liveModels(["sonnet-5"]),
    })
    expect(result.status).toBe("failed")
    if (result.status === "failed") expect(result.reason).toBe("no-credential")
  })

  test("refuses when the provider has no base URL", async () => {
    const result = await run({ credentialKey: "sk-test", fetchFn: liveModels(["sonnet-5"]) })
    expect(result.status).toBe("failed")
    if (result.status === "failed") {
      expect(result.reason).toBe("no-provider")
      expect(result.action).toContain("https://anymodel.ghostly.su/v1")
    }
  })

  test("refuses when the provider is disabled", async () => {
    const result = await run({
      credentialKey: "sk-test",
      baseURL: "https://anymodel.ghostly.su/v1",
      providerDisabled: true,
      fetchFn: liveModels(["sonnet-5"]),
    })
    expect(result.status).toBe("failed")
    if (result.status === "failed") expect(result.reason).toBe("no-provider")
  })

  test("passes with a live key and the fallback planner model served", async () => {
    const result = await run({
      credentialKey: "sk-test",
      baseURL: "https://anymodel.ghostly.su/v1",
      fetchFn: liveModels(["sonnet-5", "sonnet-5.5", "opus-5.5"]),
    })
    expect(result.status).toBe("ok")
    if (result.status === "ok") {
      expect(result.plannerModel).toEqual({ providerID: "anymodel", modelID: "sonnet-5" })
      expect(result.models).toContain("sonnet-5")
      expect(result.warnings).toEqual([])
    }
  })

  test("accepts a key from provider settings when the credential store has none", async () => {
    const result = await run({
      settingsKey: "sk-from-config",
      baseURL: "https://anymodel.ghostly.su/v1",
      fetchFn: liveModels(["sonnet-5"]),
    })
    expect(result.status).toBe("ok")
  })

  test("refuses a rejected key as auth, naming the fix", async () => {
    const result = await run({
      credentialKey: "sk-dead",
      baseURL: "https://anymodel.ghostly.su/v1",
      fetchFn: async () => json({}, 401),
    })
    expect(result.status).toBe("failed")
    if (result.status === "failed") {
      expect(result.reason).toBe("auth")
      expect(result.action).toContain("Replace the stored Anymodel key")
    }
  })

  test("refuses an unreachable endpoint instead of creating blindly", async () => {
    const result = await run({
      credentialKey: "sk-test",
      baseURL: "https://anymodel.ghostly.su/v1",
      fetchFn: async () => {
        throw new TypeError("fetch failed")
      },
    })
    expect(result.status).toBe("failed")
    if (result.status === "failed") expect(result.reason).toBe("unreachable")
  })

  test("refuses when the planner model is not served right now", async () => {
    const result = await run({
      credentialKey: "sk-test",
      baseURL: "https://anymodel.ghostly.su/v1",
      fetchFn: liveModels(["opus-5.5"]),
    })
    expect(result.status).toBe("failed")
    if (result.status === "failed") {
      expect(result.reason).toBe("no-planner-model")
      expect(result.message).toContain("sonnet-5")
    }
  })

  test("passes a planner model on another provider when the catalog has it, with a warning", async () => {
    const result = await run({
      credentialKey: "sk-test",
      baseURL: "https://anymodel.ghostly.su/v1",
      plannerModel: { providerID: "anthropic", modelID: "claude-x" },
      catalogModelIDs: ["claude-x"],
      fetchFn: liveModels(["sonnet-5"]),
    })
    expect(result.status).toBe("ok")
    if (result.status === "ok") expect(result.warnings.length).toBe(1)
  })

  test("refuses a planner model on another provider when the catalog lacks it", async () => {
    const result = await run({
      credentialKey: "sk-test",
      baseURL: "https://anymodel.ghostly.su/v1",
      plannerModel: { providerID: "anthropic", modelID: "claude-x" },
      catalogModelIDs: ["other-model"],
      fetchFn: liveModels(["sonnet-5"]),
    })
    expect(result.status).toBe("failed")
    if (result.status === "failed") expect(result.reason).toBe("no-planner-model")
  })

  test("never leaks the key into its result", async () => {
    const result = await run({
      credentialKey: "sk-very-secret-key",
      baseURL: "https://anymodel.ghostly.su/v1",
      fetchFn: async () => json({}, 401),
    })
    expect(JSON.stringify(result)).not.toContain("sk-very-secret-key")
  })
})

describe("SocietyPreflight.checkLive", () => {
  test("is skipped when no Credential/Provider services are in the layer", async () => {
    const result = await Effect.runPromise(SocietyPreflight.checkLive())
    expect(result.status).toBe("skipped")
  })

  test("is skipped when Credential is present but Provider is not (no false failure)", async () => {
    // Regression: the Federation context provides Credential but not
    // Provider, so the endpoint cannot be determined. That must skip, not
    // report the provider as unconfigured.
    const stub = {
      all: () => Effect.succeed([] as Credential.Info[]),
      list: () => Effect.succeed([] as Credential.Info[]),
      get: () => Effect.succeed(undefined as Credential.Info | undefined),
      create: () => Effect.fail(new Error("unused") as never),
      activate: () => Effect.succeed(undefined as void),
      update: () => Effect.succeed(undefined as void),
      remove: () => Effect.succeed(undefined as void),
    } satisfies Credential.Interface
    const result = await Effect.runPromise(
      SocietyPreflight.checkLive().pipe(Effect.provideService(Credential.Service, stub)),
    )
    expect(result.status).toBe("skipped")
  })
})

describe("openSocietyTeam (G2-15)", () => {
  const roles: ReadonlyArray<Orchestra.Role> = OrchestraSchema.roles.slice(0, 3).map((spec) => ({
    ...spec,
    agent: OrchestraSchema.role(spec.id),
    origin: "builtin" as const,
  }))
  const opener = (failures: ReadonlyMap<string, number>) => {
    const attempts = new Map<string, number>()
    return {
      attempts,
      open: (role: Orchestra.Role) =>
        Effect.gen(function* () {
          const count = (attempts.get(role.id) ?? 0) + 1
          attempts.set(role.id, count)
          if (count <= (failures.get(role.id) ?? 0)) return yield* Effect.fail(new Error(`cannot open ${role.id}`))
          return { id: SessionID.create() }
        }),
    }
  }

  test("counts every worker when all open first try", async () => {
    const { open } = opener(new Map())
    const result = await Effect.runPromise(
      openSocietyTeam({ roles, open, verify: () => Effect.succeed(true) }),
    )
    expect(result).toEqual({ expected: 3, opened: 3, live: 3, failedRoles: [], unverifiedRoles: [] })
  })

  test("retries a role that fails once and still counts it", async () => {
    const { open, attempts } = opener(new Map([[roles[1].id, 1]]))
    const result = await Effect.runPromise(
      openSocietyTeam({ roles, open, verify: () => Effect.succeed(true) }),
    )
    expect(result).toEqual({ expected: 3, opened: 3, live: 3, failedRoles: [], unverifiedRoles: [] })
    expect(attempts.get(roles[1].id)).toBe(2)
  })

  test("names the roles that fail twice and counts the rest", async () => {
    const { open } = opener(new Map([[roles[0].id, 2]]))
    const result = await Effect.runPromise(
      openSocietyTeam({ roles, open, verify: () => Effect.succeed(true) }),
    )
    expect(result).toEqual({ expected: 3, opened: 2, live: 2, failedRoles: [roles[0].id], unverifiedRoles: [] })
  })

  test("reads back liveness: an opened session that is gone does not count as live", async () => {
    const { open } = opener(new Map())
    const seen: Array<SessionID> = []
    const result = await Effect.runPromise(
      openSocietyTeam({
        roles,
        open,
        verify: (id) =>
          Effect.sync(() => {
            seen.push(id)
            return seen.length !== 2
          }),
      }),
    )
    expect(result.live).toBe(2)
    expect(result.opened).toBe(3)
    expect(result.unverifiedRoles).toHaveLength(1)
  })

  test("reports zero live workers when every role fails twice", async () => {
    const { open } = opener(new Map([[roles[0].id, 2], [roles[1].id, 2], [roles[2].id, 2]]))
    const result = await Effect.runPromise(
      openSocietyTeam({ roles, open, verify: () => Effect.succeed(true) }),
    )
    // Zero live is the outcome createSociety treats as a failed creation, not
    // a Society with an empty team: every role failed, nothing opened.
    expect(result).toEqual({
      expected: 3,
      opened: 0,
      live: 0,
      failedRoles: [roles[0].id, roles[1].id, roles[2].id],
      unverifiedRoles: [],
    })
  })

  test("an empty roster is zero across the board", async () => {
    const { open } = opener(new Map())
    const result = await Effect.runPromise(
      openSocietyTeam({ roles: [], open, verify: () => Effect.succeed(true) }),
    )
    expect(result).toEqual({ expected: 0, opened: 0, live: 0, failedRoles: [], unverifiedRoles: [] })
  })
})
