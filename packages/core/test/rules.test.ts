import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { AppNodeBuilder } from "@orchestra/core/effect/app-node-builder"
import { LayerNode } from "@orchestra/util/effect/layer-node"
import { Global } from "@orchestra/util/global"
import { Database } from "@orchestra/core/database/database"
import { KV } from "@orchestra/core/kv"
import { Federation } from "@orchestra/core/federation"
import { Orchestra } from "@orchestra/core/orchestra"
import { RuleEnforce } from "@orchestra/core/rule-enforce"
import { Trigger } from "@orchestra/core/trigger"
import { readFileSync } from "node:fs"
import { Rules } from "@orchestra/core/rules"
import { Session } from "@orchestra/core/session"
import { tempGlobalLayer } from "./fixture/global"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, KV.node]), [Global.node.replace(tempGlobalLayer)]))

describe("rulebook", () => {
  it.live("global defaults become independent durable project copies, including empty and concurrent initialization", () =>
    Effect.gen(function* () {
      const kv = yield* KV.Service
      const original = yield* Rules.add(kv, Rules.GLOBAL, { text: "Original operator instruction.", by: "operator" })
      yield* Effect.all([Rules.snapshotDefaults(kv, "prj_a"), Rules.snapshotDefaults(kv, "prj_a"), Rules.snapshotDefaults(kv, "prj_b")], { concurrency: "unbounded" })
      const a = Rules.projectDefaultsScope("prj_a"), b = Rules.projectDefaultsScope("prj_b")
      expect(yield* Rules.list(kv, a)).toEqual([original.rule!])
      yield* Rules.add(kv, Rules.GLOBAL, { text: "New projects only.", by: "operator" })
      yield* Rules.snapshotDefaults(kv, "prj_a")
      expect(yield* Rules.list(kv, a)).toEqual([original.rule!])
      expect(yield* Rules.list(kv, b)).toEqual([original.rule!])
      yield* Rules.remove(kv, a, original.rule!.id, { operator: true })
      yield* Rules.snapshotDefaults(kv, "prj_a")
      expect(yield* Rules.list(kv, a)).toEqual([])
      expect((yield* Rules.list(kv, b)).map(r => r.text)).toEqual(["Original operator instruction."])
      yield* Rules.snapshotSocietyDefaults(kv, "Society A")
      yield* Rules.snapshotSocietyDefaults(kv, "Society B")
      yield* Rules.remove(kv, Rules.societyDefaultsScope("Society A"), original.rule!.id, { operator: true })
      yield* Rules.snapshotSocietyDefaults(kv, "Society A")
      expect((yield* Rules.list(kv, Rules.societyDefaultsScope("Society A"))).some(r=>r.id===original.rule!.id)).toBe(false)
      expect((yield* Rules.list(kv, Rules.societyDefaultsScope("Society B"))).some(r=>r.id===original.rule!.id)).toBe(true)
      yield* Rules.snapshotDefaults(kv, "prj_new")
      expect((yield* Rules.list(kv, Rules.projectDefaultsScope("prj_new")))).toHaveLength(2)
      const block = yield* Rules.block(kv, { project: "prj_b", societies: [] })
      expect(block).toContain("Original operator instruction.")
      expect(block).not.toContain("New projects only.")
      expect(yield* Rules.block(kv, { societies: [] })).not.toContain("Original operator instruction.")
      yield* Rules.remove(kv, Rules.GLOBAL, original.rule!.id, { operator: true })
      expect((yield* Rules.list(kv, b)).map(r => r.text)).toEqual(["Original operator instruction."])
    }),
  )

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
      // The scopes also name the asking session, its role and whether it is an Orchestrator (session/role/orchestrator rules).
      expect(president).toMatchObject({ chatOf: "Lead", societies: ["Lead"], orchestrator: false })
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
})

describe("rulebook scopes", () => {
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
      const refused = yield* Rules.remove(kv, Rules.orchestratorScope("prj_x"), id).pipe(Effect.flip)
      expect(refused._tag).toBe("Rules.ProtectedError")
      expect(yield* Rules.remove(kv, Rules.orchestratorScope("prj_x"), id, { operator: true })).toBe(true)
    }),
  )
})


describe("scheduled request rule lifecycle", () => {
  it.live("uses rules edited after schedule creation and blocks effects after corrupted reload", () =>
    Effect.gen(function* () {
      const kv = yield* KV.Service
      const project = "prj_scheduled_rules"
      const scope = Rules.projectScope(project)
      const session = "scheduled-rule-fixture"
      const made = Trigger.create({ kind: "interval", spec: "60", prompt: "Run the stored task" }, {
        id: "rule_schedule", projectID: project, now: 1000, existing: 0,
      })
      if (!made.ok) throw new Error(made.error)
      yield* Rules.loadCurrent(kv, { project, societies: [] }, session)
      expect(RuleEnforce.unavailableRefusal(session, "shell", {})).toBeUndefined()
      // The operator edits the rulebook after the schedule was saved.
      yield* Rules.add(kv, scope, { text: "deny tool shell", by: "operator" })
      const fired = Trigger.afterFire(made.trigger, 3_601_000)
      expect(fired.total).toBe(1)
      yield* Rules.loadCurrent(kv, { project, societies: [] }, session)
      let effects = 0
      const runEffect = () => {
        const gate = RuleEnforce.unavailableRefusal(session, "shell", {})
        const deny = RuleEnforce.violation(RuleEnforce.recall(session), { tool: "shell", agent: "orchestrator", input: {} })
        if (!gate && !deny) effects++
      }
      runEffect()
      expect(effects).toBe(0)
      yield* kv.set(`rules/${scope}`, [{ corrupt: true }])
      const failed = yield* Rules.loadCurrent(kv, { project, societies: [] }, session).pipe(Effect.flip)
      expect(failed._tag).toBe("Rules.LoadError")
      runEffect()
      expect(effects).toBe(0)
      expect(RuleEnforce.unavailableRefusal(session, "rules", { action: "list" })).toBeUndefined()
      yield* kv.set(`rules/${scope}`, [])
      yield* Rules.loadCurrent(kv, { project, societies: [] }, session)
      runEffect()
      expect(effects).toBe(1)
    }),
  )

  it.live("the context and pre-execution hooks use the shared gate for every request", () => Effect.sync(() => {
    const team = readFileSync(new URL("../src/plugin/team.ts", import.meta.url), "utf8")
    const start = team.indexOf('ctx.session.hook("context"')
    expect(start).toBeGreaterThan(0)
    const loading = team.indexOf("RuleEnforce.loading(", start)
    const scopeLoad = team.indexOf("Rules.scopesOf(", start)
    const current = team.indexOf("Rules.loadCurrent(", start)
    expect(loading).toBeGreaterThan(start)
    expect(loading).toBeLessThan(scopeLoad)
    expect(scopeLoad).toBeLessThan(current)
    const tool = readFileSync(new URL("../src/tool/plugin/rules.ts", import.meta.url), "utf8")
    const hook = tool.indexOf('ctx.tool.hook("execute.before"')
    const gate = tool.indexOf("RuleEnforce.unavailableRefusal(", hook)
    const directives = tool.indexOf("RuleEnforce.violation(", gate)
    expect(hook).toBeGreaterThan(0)
    expect(gate).toBeGreaterThan(hook)
    expect(gate).toBeLessThan(directives)
  }))
})


it.live("deduplicates only byte-identical prompt texts while retaining every enforcement entry and stored scope", () =>
  Effect.gen(function* () {
    const kv = yield* KV.Service
    const text = "Never edit generated fixtures without an operator instruction."
    const scopes = [Rules.societyScope("Dedup"), Rules.projectScope("prj_dedup"), Rules.roleScope("prj_dedup", "team-developer"), Rules.sessionScope("ses_dedup"), Rules.projectDefaultsScope("prj_dedup")]
    for (const scope of scopes) yield* Rules.add(kv, scope, { text, by: scope === scopes[0] ? "operator" : "team-developer" })
    const similar = "Never edit generated fixtures without an Operator instruction."
    yield* Rules.add(kv, Rules.orchestratorScope("prj_dedup"), { text: similar, by: "operator" })
    const loaded = yield* Rules.loadCurrent(kv, { societies: ["Dedup"], project: "prj_dedup", orchestrator: true, role: "team-developer", session: "ses_dedup" }, "ses_dedup")
    expect(loaded.block.split(text).length - 1).toBe(1)
    expect(loaded.block).toContain("[Society, Project, Role, Session, Defaults copy]")
    expect(loaded.block).toContain(similar)
    expect(loaded.entries.filter(entry => entry.text === text)).toHaveLength(5)
    expect(RuleEnforce.recall("ses_dedup")).toEqual(loaded.entries)
    expect(loaded.entries[0]?.by).toBe("operator")
    for (const scope of scopes) expect((yield* Rules.listStrict(kv, scope)).some(rule => rule.text === text)).toBe(true)
    const former = ["Society", "Project", "Role", "Session", "Defaults copy"].map(title => `- [${title}] ${text}`).join("\n")
    const now = loaded.block.split("\n").find(line => line.includes(text))!
    expect(now.length).toBeLessThan(former.length)
  }),
)
