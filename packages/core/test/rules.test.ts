import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { AppNodeBuilder } from "@orchestra/core/effect/app-node-builder"
import { LayerNode } from "@orchestra/util/effect/layer-node"
import { Global } from "@orchestra/util/global"
import { Database } from "@orchestra/core/database/database"
import { KV } from "@orchestra/core/kv"
import { Federation } from "@orchestra/core/federation"
import { Orchestra } from "@orchestra/core/orchestra"
import { Rules } from "@orchestra/core/rules"
import { Session } from "@orchestra/core/session"
import { tempGlobalLayer } from "./fixture/global"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, KV.node]), [Global.node.replace(tempGlobalLayer)]))

describe("rulebook", () => {
  it.live("keeps rules per scope, refuses duplicates and empty text, and removes by id", () =>
    Effect.gen(function* () {
      const kv = yield* KV.Service
      const scope = Rules.projectScope("prj_a")
      const first = yield* Rules.add(kv, scope, { text: "  Never edit   generated files. ", by: "team-developer" })
      expect(first.rule?.text).toBe("Never edit generated files.")
      expect(yield* Rules.add(kv, scope, { text: "never edit generated files.", by: "x" })).toEqual({ error: "That rule already exists." })
      expect(yield* Rules.add(kv, scope, { text: "   ", by: "x" })).toEqual({ error: "A rule needs text." })
      expect((yield* Rules.list(kv, Rules.projectScope("prj_b"))).length).toBe(0)

      const rule = first.rule
      if (!rule) throw new Error("expected a rule")
      expect(yield* Rules.remove(kv, scope, rule.id)).toBe(true)
      expect(yield* Rules.remove(kv, scope, rule.id)).toBe(false)
      expect(yield* Rules.list(kv, scope)).toEqual([])
    }),
  )

  it.live("seeds the default society rules once, and never duplicates them", () =>
    Effect.gen(function* () {
      const kv = yield* KV.Service
      const scope = Rules.societyScope("Seeded")
      for (const text of Rules.DEFAULT_SOCIETY_RULES) expect(text.length).toBeLessThanOrEqual(Rules.MAX_TEXT)
      yield* Rules.seedDefaults(kv, scope)
      const first = yield* Rules.list(kv, scope)
      expect(first).toHaveLength(Rules.DEFAULT_SOCIETY_RULES.length)
      expect(first.every((rule) => rule.by === "operator")).toBe(true)
      expect(first.map((rule) => rule.text)).toEqual([...Rules.DEFAULT_SOCIETY_RULES])
      // Seeding again changes nothing, and a society with its own rules keeps them.
      yield* Rules.seedDefaults(kv, scope)
      expect(yield* Rules.list(kv, scope)).toHaveLength(Rules.DEFAULT_SOCIETY_RULES.length)
      const own = Rules.societyScope("OwnRules")
      yield* Rules.add(kv, own, { text: "Our own rule.", by: "operator" })
      yield* Rules.seedDefaults(kv, own)
      expect((yield* Rules.list(kv, own)).map((rule) => rule.text)).toEqual([
        "Our own rule.",
        ...Rules.DEFAULT_SOCIETY_RULES,
      ])
    }),
  )

  it.live("caps a scope and refuses long rules instead of cutting them off", () =>
    Effect.gen(function* () {
      const kv = yield* KV.Service
      const scope = Rules.societyScope("Games")
      for (let index = 0; index < Rules.MAX_PER_SCOPE; index++)
        expect((yield* Rules.add(kv, scope, { text: `rule ${index}`, by: "operator" })).rule).toBeDefined()
      expect(yield* Rules.add(kv, scope, { text: "one too many", by: "operator" })).toMatchObject({ error: expect.stringContaining("already has") })
      // A long rule is refused, not silently cut to 240 characters: the stored text must stay what was written.
      const long = yield* Rules.add(kv, Rules.GLOBAL, { text: "x".repeat(1000), by: "operator" })
      expect(long.error).toContain(String(Rules.MAX_TEXT))
      expect(yield* Rules.list(kv, Rules.GLOBAL)).toEqual([])
    }),
  )

  it.live("renders one block with the Society's rules first, then the project's, then the global ones", () =>
    Effect.gen(function* () {
      const kv = yield* KV.Service
      yield* Rules.add(kv, Rules.societyScope("Shop"), { text: "Every project writes its API contract first.", by: "operator" })
      yield* Rules.add(kv, Rules.projectScope("prj_shop"), { text: "Use bun, not npm.", by: "team-developer" })
      const block = yield* Rules.block(kv, { project: "prj_shop", societies: ["Shop"] })
      const lines = block.split("\n")
      const society = lines.findIndex((line) => line.includes("[Society]"))
      const project = lines.findIndex((line) => line.includes("[Project]"))
      expect(society).toBeGreaterThan(0)
      expect(project).toBeGreaterThan(society)
      // A session outside the Society and the project sees none of their rules.
      expect(yield* Rules.block(kv, { societies: [] })).not.toContain("[Society]")
    }),
  )

  it.live("says nothing when no rule applies", () =>
    Effect.gen(function* () {
      const kv = yield* KV.Service
      expect(yield* Rules.block(kv, { project: "prj_none", societies: ["Nothing"] })).not.toContain("[Project]")
    }),
  )

  it.live("a worker cannot remove a rule the operator wrote, in any scope, and edits are recorded", () =>
    Effect.gen(function* () {
      const kv = yield* KV.Service
      const scope = Rules.projectScope("prj_guarded")
      const added = yield* Rules.add(kv, scope, { text: "Never ship on Friday.", by: "operator" })
      const id = added.rule?.id
      if (!id) throw new Error("expected a rule")
      // A worker's remove fails with a typed error, and the rule is still there.
      const refused = yield* Rules.remove(kv, scope, id).pipe(Effect.flip)
      expect(refused._tag).toBe("Rules.ProtectedError")
      expect(yield* Rules.list(kv, scope)).toHaveLength(1)
      // The operator removes their own rule; a teammate's rule is removable by anyone.
      expect(yield* Rules.remove(kv, scope, id, { operator: true })).toBe(true)
      const other = yield* Rules.add(kv, scope, { text: "Use bun, not npm.", by: "team-developer" })
      if (!other.rule) throw new Error("expected a rule")
      expect(yield* Rules.remove(kv, scope, other.rule.id)).toBe(true)
      const entries = yield* Rules.history(kv, scope)
      expect(entries.map((entry) => entry.action)).toEqual(["add", "remove", "add", "remove"])
    }),
  )

  it.live("corrupt stored rules fail the load instead of reading as empty", () =>
    Effect.gen(function* () {
      const kv = yield* KV.Service
      const scope = Rules.projectScope("prj_broken")
      yield* kv.set(
        `rules/${scope}`,
        [
          { id: "r1", text: "Never edit generated files.", by: "operator", at: 1 },
          { bogus: true },
        ] as unknown as KV.Value,
      )
      // Display still shows the good rule and says one entry is corrupt.
      expect((yield* Rules.inspect(kv, scope)).corrupt).toBe(1)
      expect(yield* Rules.list(kv, scope)).toHaveLength(1)
      // Anything that acts on the rules refuses to trust a half-loaded scope.
      const strict = yield* Rules.listStrict(kv, scope).pipe(Effect.flip)
      expect(strict._tag).toBe("Rules.LoadError")
      const blocked = yield* Rules.block(kv, { project: "prj_broken", societies: [] }).pipe(Effect.flip)
      expect(blocked._tag).toBe("Rules.LoadError")
    }),
  )

  it.live("a contradiction between scopes is an error, not a judgement call", () =>
    Effect.gen(function* () {
      const kv = yield* KV.Service
      yield* Rules.add(kv, Rules.societyScope("Shop"), { text: "Always run the checks.", by: "operator" })
      yield* Rules.add(kv, Rules.projectScope("prj_shop"), { text: "Never run the checks.", by: "operator" })
      const failed = yield* Rules.block(kv, { project: "prj_shop", societies: ["Shop"] }).pipe(Effect.flip)
      expect(failed._tag).toBe("Rules.ConflictError")
    }),
  )

  it.live("lead groups give their President and their projects the society rules", () =>
    Effect.gen(function* () {
      const groups = [{ name: "Lead", projects: ["prj_a"], mode: "lead" }]
      const project = yield* Rules.scopesOf(
        makeScopes({
          sessionID: "ses_main",
          sessions: { ses_main: {} },
          mainOf: { ses_main: { id: "prj_a" } },
          groups,
        }),
      )
      expect(project.societies).toEqual(["Lead"])
      // The President's chat session reads the same society rules.
      const president = yield* Rules.scopesOf(
        makeScopes({
          sessionID: "ses_president",
          sessions: {
            ses_president: {
              metadata: {
                "orchestra:group-supervisor": { groupName: "Lead", leader: "prj_a", mode: "lead" },
              },
            },
          },
          groups: [{ name: "Lead", projects: ["prj_a"], mode: "lead", supervisor: "ses_president" }],
        }),
      )
      expect(president).toEqual({ chatOf: "Lead", societies: ["Lead"] })
    }),
  )

  it.live("a sandbox session inherits its source project's rules and societies", () =>
    Effect.gen(function* () {
      const kv = yield* KV.Service
      yield* Rules.add(kv, Rules.projectScope("prj_src"), { text: "Use bun, not npm.", by: "operator" })
      yield* Rules.add(kv, Rules.societyScope("Shop"), { text: "Every project writes its API contract first.", by: "operator" })
      const scopes = yield* Rules.scopesOf(
        makeScopes({
          sessionID: "ses_box",
          sessions: { ses_box: {} },
          mainOf: {
            ses_box: {
              id: "prj_box",
              sandbox: { source: "/work/src", home: "/tmp/box", isolation: "environment" },
            },
          },
          projects: [
            { id: "prj_src", directory: "/work/src" },
            {
              id: "prj_box",
              directory: "/tmp/box/repo",
              sandbox: { source: "/work/src", home: "/tmp/box", isolation: "environment" },
            },
          ],
          groups: [{ name: "Shop", projects: ["prj_src"], mode: "council" }],
        }),
      )
      expect(scopes.project).toBe("prj_box")
      expect(scopes.societies).toEqual([])
      expect(scopes.inherited).toEqual({ projects: ["prj_src"], societies: ["Shop"] })
      const block = yield* Rules.block(kv, scopes)
      expect(block).toContain("- [Project (inherited)] Use bun, not npm.")
      expect(block).toContain("- [Society (inherited)] Every project writes its API contract first.")
    }),
  )

  it.live("scopes that cannot be determined fail instead of reading as no rules apply", () =>
    Effect.gen(function* () {
      const failed = yield* Rules.scopesOf(
        makeScopes({
          sessionID: "ses_main",
          sessions: { ses_main: {} },
          groups: undefined,
        }),
      ).pipe(Effect.flip)
      expect(failed._tag).toBe("Rules.ScopesError")
    }),
  )
})

// Minimal stand-ins for the three services scopesOf reads: a session registry, the project
// registry, and the group registry. Only the methods scopesOf calls are present.
const makeScopes = (options: {
  sessionID: string
  sessions?: Record<string, { parentID?: string; metadata?: Record<string, unknown> }>
  mainOf?: Record<string, unknown>
  owners?: Record<string, string>
  projects?: Array<Record<string, unknown>>
  groups?: Array<Record<string, unknown>>
}) => ({
  sessionID: options.sessionID,
  sessions: {
    get: (id: string) => {
      const found = options.sessions?.[id]
      return found === undefined
        ? Effect.fail(new Error(`no session ${id}`))
        : Effect.succeed({ id, parentID: found.parentID, metadata: found.metadata ?? {} })
    },
  } as unknown as Session.Interface,
  orchestra: {
    mainOf: (id: string) => Effect.succeed(options.mainOf?.[id]),
    owners: () => Effect.succeed(options.owners ?? {}),
    projects: () => Effect.succeed(options.projects ?? []),
  } as unknown as Orchestra.Interface,
  federation: {
    groups: () =>
      options.groups === undefined ? Effect.fail(new Error("groups unavailable")) : Effect.succeed(options.groups),
  } as unknown as Federation.Interface,

  it.live("session, role and orchestrator rules ride only on the sessions they are for, and operator ones resist workers", () =>
    Effect.gen(function* () {
      const kv = yield* KV.Service
      yield* Rules.add(kv, Rules.sessionScope("ses_1"), { text: "Keep answers short.", by: "team-orchestrator" })
      yield* Rules.add(kv, Rules.roleScope("prj_x", "team-tester"), { text: "Run the suite before reporting.", by: "team-orchestrator" })
      const operator = yield* Rules.add(kv, Rules.orchestratorScope("prj_x"), { text: "Ask before spending money.", by: "operator" })
      const worker = yield* Rules.block(kv, { societies: [], project: "prj_x", session: "ses_1", role: "team-tester", orchestrator: false })
      expect(worker).toContain("[Session] Keep answers short.")
      expect(worker).toContain("[Role] Run the suite before reporting.")
      expect(worker).not.toContain("Ask before spending money.")
      const other = yield* Rules.block(kv, { societies: [], project: "prj_x", session: "ses_2", role: "team-developer", orchestrator: false })
      expect(other).not.toContain("Keep answers short.")
      expect(other).not.toContain("Run the suite")
      const boss = yield* Rules.block(kv, { societies: [], project: "prj_x", session: "ses_0", role: "team-orchestrator", orchestrator: true })
      expect(boss).toContain("[Orchestrator] Ask before spending money.")
      const id = operator.rule?.id ?? ""
      const refused = yield* Rules.remove(kv, Rules.orchestratorScope("prj_x"), id).pipe(Effect.either)
      expect(refused._tag).toBe("Left")
      expect(yield* Rules.remove(kv, Rules.orchestratorScope("prj_x"), id, { operator: true })).toBe(true)
    }),
  )
})
