import { describe, expect, test } from "bun:test"
import { ToolFailure } from "@orchestra/ai"
import { Effect, Fiber, Layer, Schema } from "effect"
import { AppNodeBuilder } from "@orchestra/core/effect/app-node-builder"
import { LayerNode } from "@orchestra/util/effect/layer-node"
import { makeLocationNode } from "@orchestra/util/effect/app-node"
import { Agent } from "@orchestra/core/agent"
import { Bus } from "@orchestra/core/bus"
import { Database } from "@orchestra/core/database/database"
import { Location } from "@orchestra/core/location"
import { Permission } from "@orchestra/core/permission"
import { PermissionSaved } from "@orchestra/core/permission/saved"
import { Project } from "@orchestra/core/project"
import { ProjectTable } from "@orchestra/core/project/sql"
import { Session } from "@orchestra/core/session"
import { SessionStore } from "@orchestra/core/session/store"
import { SessionTable } from "@orchestra/core/session/sql"
import { SkillCatalogTool } from "@orchestra/core/tool/plugin/skill-catalog"
import { McpTool } from "@orchestra/core/tool/mcp"
import { Tool } from "@orchestra/core/tool"
import { SkillMarketplace } from "@orchestra/core/skill-marketplace/index"
import { SkillMarketplace as SkillMarketplaceContract } from "@orchestra/schema/skill-marketplace"
import { SkillMarketplaceUpstream } from "@orchestra/core/skill-marketplace/upstream"
import { AbsolutePath } from "@orchestra/core/schema"
import { location } from "./fixture/location"
import { it } from "./lib/effect"
import { permissionLayer } from "./lib/permission"
import { codeModeListings, executeTool, registerToolPlugin, toolIdentity } from "./lib/tool"

const sessionID = Session.ID.make("ses_skill_catalog_test")

/** A row built through the contract, so a fixture the catalog would refuse fails here. */
const row = (fields: Omit<Partial<SkillMarketplaceContract.Skill>, "id"> & { id: string }) =>
  Schema.decodeUnknownSync(SkillMarketplaceContract.Skill)({
    author: "",
    contentLanguage: "en",
    githubUrl: "",
    skillUrl: "",
    stars: 0,
    updatedAt: 0,
    ...fields,
  })

/**
 * Rows taken from the retired proxy's own cache of real `/skills/search` answers
 * (`skillsMP/cache.db`, `search:*` rows`). They are public marketplace listings: the name,
 * description, star count and GitHub URL are what the catalog hands any caller.
 */
const NANO = row({
  id: "openclaw-openclaw-skills-nano-pdf-skill-md",
  name: "nano-pdf",
  author: "openclaw",
  description: "Edit PDFs with natural-language instructions using the nano-pdf CLI.",
  contentLanguage: "en",
  githubUrl: "https://github.com/openclaw/openclaw/tree/main/skills/nano-pdf",
  skillUrl: "https://skillsmp.com/creators/openclaw/openclaw/skills-nano-pdf",
  stars: 391533,
  updatedAt: 1779808673,
})

const SUMMARIZE = row({
  id: "openclaw-openclaw-skills-summarize-skill-md",
  name: "summarize",
  author: "openclaw",
  description: "Summarize or transcribe URLs, YouTube/videos, podcasts, articles, transcripts, PDFs, and local files.",
  contentLanguage: "en",
  githubUrl: "https://github.com/openclaw/openclaw/tree/main/skills/summarize",
  skillUrl: "https://skillsmp.com/creators/openclaw/openclaw/skills-summarize",
  stars: 391533,
  updatedAt: 1779808673,
})

const RAW_PDF = "https://raw.githubusercontent.com/openclaw/openclaw/main/skills/nano-pdf/SKILL.md"
const BODY = "---\nname: nano-pdf\ndescription: Edit PDFs with natural-language instructions\n---\n\nRun the CLI.\n"

/** What the harness reports back: what the catalog was asked, and what was offered to save. */
type Seen = {
  searches: SkillMarketplace.SearchInput[]
  reads: string[]
  /** Permission rules offered, and skills actually written globally. */
  saves: string[]
  kept: string[]
  asked: string[]
}

const seen = (): Seen => ({ searches: [], reads: [], saves: [], kept: [], asked: [] })

const grant = (input: { action: string; resources: readonly string[]; save?: readonly string[] }) =>
  `${input.action}:${(input.save ?? []).join(",")}`

/** How the permission edge refuses, which is the difference the model ends up reading. */
type Refusal = "blocked" | "corrected"

const FEEDBACK = "No, use the skill tool instead of the marketplace"

const hits = (rows: ReadonlyArray<typeof NANO>) =>
  rows.map((skill) => ({ skill, score: 100, matched: { name: [skill.name], description: [] } }))

/**
 * The catalog behind the tool, with only the edge that leaves the machine replaced. Every refusal
 * below is one the service really produces, so the leaf is tested against its own contract.
 */
const catalog = (options: {
  rows?: ReadonlyArray<typeof NANO>
  content?: string
  failure?: Effect.Effect<never, SkillMarketplaceUpstream.UpstreamError>
  seen: Seen
}) =>
  Layer.mock(SkillMarketplace.Service, {
    search: (input) => {
      options.seen.searches.push(input)
      if (options.failure !== undefined) return options.failure
      return Effect.succeed({ hits: hits(options.rows ?? [NANO, SUMMARIZE]), cached: false, damage: undefined })
    },
    read: (input) => {
      options.seen.reads.push(input.name)
      if (options.failure !== undefined) return options.failure
      const skill = (options.rows ?? [NANO, SUMMARIZE]).find((row) => row.name === input.name)
      if (skill === undefined)
        return Effect.fail(
          new SkillMarketplaceUpstream.UpstreamError({ message: `The catalog cache holds no skill called "${input.name}". Search first, and use a name from the results.` }),
        )
      return Effect.succeed({
        name: skill.name,
        content: options.content ?? BODY,
        truncated: false,
        source: RAW_PDF,
        applied: `/project/.opencode/skills/${skill.name}/SKILL.md`,
        scan: { score: 0, recommendation: "SAFE" as const, findings: [] },
      })
    },
    save: (input) => {
      options.seen.kept.push(input.name)
      return Effect.succeed({
        path: `/home/user/.config/opencode/skills/${input.name}/SKILL.md`,
        existed: false,
      })
    },
    stats: Effect.succeed({
      cached: 0,
      degraded: false,
      damage: undefined,
      updatedAt: undefined,
      directory: "/project",
    }),
  })

/** The tool against the real registry with only the catalog and the permission edge replaced. */
function harness(options: Parameters<typeof catalog>[0], refusal?: Refusal) {
  const report = options.seen
  return AppNodeBuilder.build(
    LayerNode.group([
      Tool.node,
      makeLocationNode({
        name: "test/skill-catalog-plugin",
        layer: Layer.effectDiscard(registerToolPlugin(SkillCatalogTool.Plugin)),
        deps: [Tool.node, SkillMarketplace.node, Permission.node],
      }),
    ]),
    [
      Location.node.replace(
        Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make("/project") }))),
      ),
      Permission.node.replace(
        permissionLayer({
          assert: (input) => {
            report.asked.push(`${input.action}:${input.resources.join(",")}`)
            report.saves.push(grant(input))
            return refusal === undefined
              ? Effect.void
              : refusal === "corrected"
                ? Effect.fail(new Permission.CorrectedError({ feedback: FEEDBACK }))
                : Effect.fail(
                    new Permission.BlockedError({
                      rules: [],
                      permission: input.action,
                      resources: input.resources,
                      reason: "Permission refused by the test",
                    }),
                  )
          },
        }),
      ),
      SkillMarketplace.node.replace(catalog(options)),
    ],
  )
}

const call = (id: string, input: Record<string, unknown>) => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id, name: SkillCatalogTool.name, input },
})

const run = (tools: Tool.Interface, id: string, input: Record<string, unknown>) => executeTool(tools, call(id, input))

/** The text a model reads: only `content` ever reaches it. */
const modelText = (result: { readonly content?: ReadonlyArray<Tool.Content> }) =>
  (result.content ?? [])
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n")

/** The model-facing refusal text, unescaped so a test can read it the way the model does. */
const refusal = (result: { readonly error?: { readonly message?: string } }) => result.error?.message ?? ""

/**
 * The same tool, but with the real permission layer behind it: rules are stored on the agent
 * and evaluated by production code, so a deny here is the same deny the user would get.
 */
function guardedHarness(report: Seen) {
  return AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      Bus.node,
      SessionStore.node,
      PermissionSaved.node,
      Agent.node,
      Permission.node,
      Tool.node,
      makeLocationNode({
        name: "test/skill-catalog-plugin",
        layer: Layer.effectDiscard(registerToolPlugin(SkillCatalogTool.Plugin)),
        deps: [Tool.node, SkillMarketplace.node, Permission.node],
      }),
    ]),
    [
      Location.node.replace(
        Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make("/project") }))),
      ),
      SkillMarketplace.node.replace(catalog({ rows: [NANO], seen: report })),
    ],
  )
}

/** A project row, a session row and the agent's own rules: what `Permission.assert` reads. */
function seedRules(rules: Permission.Ruleset) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: Project.ID.global,
        slug: "test",
        directory: "/project",
        title: "test",
        version: "test",
        agent: toolIdentity.agent,
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    const agents = yield* Agent.Service
    yield* agents.transform((editor) =>
      editor.update(toolIdentity.agent, (agent) => {
        agent.permissions = [...rules]
      }),
    )
    yield* Effect.void
  })
}

describe("SkillCatalogTool", () => {
  it.live("searches the catalog and hands the model one compact row per skill", () => {
    const report = seen()
    return Effect.gen(function* () {
      const tools = yield* Tool.Service

      const result = yield* run(tools, "call-search", { action: "search", query: "pdf", limit: 3 })

      expect(result).toMatchObject({ status: "completed" })
      expect(report.searches).toEqual([{ query: "pdf", limit: 3 }])
      // Both rule surfaces, the old MCP name first, so a rule written while this tool called that
      // server still stops the call before anything else is asked of the user.
      expect(report.asked).toEqual(["skillsmp_search_skills:search_skills", "skill_catalog:search_skills"])
      // Each prompt offers the one tool it is about to call as a lasting rule, which is what puts
      // "Always allow" on the dialog at all.
      expect(report.saves).toEqual(["skillsmp_search_skills:search_skills", "skill_catalog:search_skills"])
      const output = result.output as {
        reported: number
        cached: boolean
        skills: ReadonlyArray<{ name: string; stars: number; url: string; description: string }>
      }
      // `reported` counts what came back on this page, not the catalog: reading it as a catalog
      // size would invent a claim the catalog never made.
      expect(output.reported).toBe(2)
      expect(output.cached).toBe(false)
      expect(output.skills.map((skill) => skill.name)).toEqual(["nano-pdf", "summarize"])
      expect(output.skills[0].stars).toBe(391533)
      expect(output.skills[0].url).toBe("https://github.com/openclaw/openclaw/tree/main/skills/nano-pdf")
      expect(output.skills[0].description).toBe(NANO.description)
      const text = modelText(result)
      expect(text).toContain("Found 2 skills:")
      expect(text).toContain("- nano-pdf (391533 stars)")
      expect(text).toContain(NANO.description)
    }).pipe(Effect.provide(harness({ seen: report })))
  })

  it.live("says when an answer came from this project's cache", () => {
    const report = seen()
    return Effect.gen(function* () {
      const tools = yield* Tool.Service

      const result = yield* run(tools, "call-cached", { action: "search", query: "pdf" })

      expect(result).toMatchObject({ status: "completed" })
      expect(modelText(result)).toContain("Found 2 skills:")
    }).pipe(Effect.provide(harness({ seen: report })))
  })

  it.live("reads one skill and reports where the project kept it", () => {
    const report = seen()
    return Effect.gen(function* () {
      const tools = yield* Tool.Service

      const result = yield* run(tools, "call-get", { action: "get", id: "nano-pdf" })

      expect(result).toMatchObject({ status: "completed" })
      expect(report.reads).toEqual(["nano-pdf"])
      expect(report.asked).toEqual(["skillsmp_get_skill:get_skill", "skill_catalog:get_skill"])
      expect(modelText(result)).toContain("Run the CLI.")
      expect((result.output as { action: string; saved: string }).action).toBe("get")
      expect((result.output as { saved: string }).saved).toBe("/project/.opencode/skills/nano-pdf/SKILL.md")
      // Reading a skill is not a decision to keep it everywhere.
      expect(report.saves).toEqual(["skillsmp_get_skill:get_skill", "skill_catalog:get_skill"])
    }).pipe(Effect.provide(harness({ seen: report })))
  })

  it.live("keeps a huge skill text inside the context budget and admits the cut", () => {
    const report = seen()
    return Effect.gen(function* () {
      const tools = yield* Tool.Service

      const result = yield* run(tools, "call-huge", { action: "get", id: "nano-pdf" })

      expect(result).toMatchObject({ status: "completed" })
      const output = result.output as { output: string; truncated?: boolean }
      expect(output.truncated).toBe(true)
      expect(output.output.length).toBe(4000)
    }).pipe(Effect.provide(harness({ seen: report, content: "x".repeat(50_000) })))
  })

  it.live("caps a runaway limit at the tool maximum", () => {
    const report = seen()
    const many = Array.from({ length: 50 }, (_, index) => row({ ...NANO, id: `skill-${index}`, name: `skill-${index}` }))
    return Effect.gen(function* () {
      const tools = yield* Tool.Service

      const result = yield* run(tools, "call-cap", { action: "search", query: "x", limit: 500 })

      expect(result).toMatchObject({ status: "completed" })
      expect(report.searches[0].limit).toBe(SkillCatalogTool.MAX_RESULTS)
      expect((result.output as { skills: ReadonlyArray<unknown> }).skills).toHaveLength(SkillCatalogTool.MAX_RESULTS)
    }).pipe(Effect.provide(harness({ seen: report, rows: many })))
  })

  it.live("keeps a nonsense limit from reaching the catalog as nonsense", () => {
    const report = seen()
    return Effect.gen(function* () {
      const tools = yield* Tool.Service

      yield* run(tools, "call-zero", { action: "search", query: "x", limit: 0 })
      yield* run(tools, "call-default", { action: "search", query: "x" })

      expect(report.searches[0].limit).toBe(1)
      expect(report.searches[1].limit).toBe(5)
    }).pipe(Effect.provide(harness({ seen: report })))
  })

  it.live("forwards the search filters the model asked for", () => {
    const report = seen()
    return Effect.gen(function* () {
      const tools = yield* Tool.Service

      yield* run(tools, "call-filters", {
        action: "search",
        query: "scraping",
        category: "web-development",
        language: "en",
        sort: "recent",
      })

      expect(report.searches[0]).toEqual({
        query: "scraping",
        limit: 5,
        category: "web-development",
        language: "en",
        sortBy: "recent",
      })
    }).pipe(Effect.provide(harness({ seen: report })))
  })

  it.live("refuses a blank query instead of asking the catalog for nothing", () => {
    const report = seen()
    return Effect.gen(function* () {
      const tools = yield* Tool.Service

      const result = yield* run(tools, "call-blank-query", { action: "search", query: "   " })

      expect(result).toMatchObject({ status: "error" })
      expect(refusal(result)).toContain("search needs query")
      expect(report.searches).toEqual([])
      expect(report.asked).toEqual([])
    }).pipe(Effect.provide(harness({ seen: report })))
  })

  it.live("refuses a language code the catalog does not have, instead of failing the whole call", () => {
    const report = seen()
    return Effect.gen(function* () {
      const tools = yield* Tool.Service

      const refused = yield* run(tools, "call-language-bad", { action: "search", query: "pdf", language: "klingon" })
      const allowed = yield* run(tools, "call-language-ok", { action: "search", query: "pdf", language: "rus" })

      // `language` is a closed enum on the catalog side: a code outside it fails the call, and a
      // refusal here names the codes the model can correct itself from.
      expect(refused).toMatchObject({ status: "error" })
      expect(refusal(refused)).toContain("klingon")
      expect(refusal(refused)).toContain("en")
      expect(report.searches).toHaveLength(1)
      expect(allowed).toMatchObject({ status: "completed" })
      expect(report.searches[0].language).toBe("rus")
    }).pipe(Effect.provide(harness({ seen: report })))
  })

  it.live("refuses a call that is missing its argument without asking anything", () => {
    const report = seen()
    return Effect.gen(function* () {
      const tools = yield* Tool.Service

      const search = yield* run(tools, "call-no-query", { action: "search" })
      const get = yield* run(tools, "call-no-id", { action: "get" })

      expect(search).toMatchObject({ status: "error" })
      expect(refusal(search)).toContain("search needs query")
      expect(get).toMatchObject({ status: "error" })
      expect(refusal(get)).toContain("get needs id")
      expect(report.searches).toEqual([])
      expect(report.reads).toEqual([])
      expect(report.asked).toEqual([])
    }).pipe(Effect.provide(harness({ seen: report })))
  })

  it.live("an empty answer is an answer, not an error the model must interpret", () => {
    const report = seen()
    return Effect.gen(function* () {
      const tools = yield* Tool.Service

      const result = yield* run(tools, "call-empty", { action: "search", query: "zzzqqqnosuchskillzzz" })

      expect(result).toMatchObject({ status: "completed" })
      const output = result.output as { skills: unknown[]; reported: number }
      expect(output.skills).toEqual([])
      expect(output.reported).toBe(0)
      expect(modelText(result)).toBe("No skill matched those words.")
    }).pipe(Effect.provide(harness({ seen: report, rows: [] })))
  })

  it.live("turns a catalog refusal into a refusal the model can read", () => {
    const report = seen()
    // The live body the retired proxy received once its daily quota was spent: the catalog is
    // fine, the upstream said no. The model must not turn this into "there is no such skill".
    const failure = Effect.fail(
      new SkillMarketplaceUpstream.UpstreamError({
        message: "Daily API quota of 50 requests exceeded. Resets at midnight UTC.",
        code: "DAILY_QUOTA_EXCEEDED",
      }),
    )
    return Effect.gen(function* () {
      const tools = yield* Tool.Service

      const result = yield* run(tools, "call-upstream", { action: "search", query: "pdf" })

      expect(result).toMatchObject({ status: "error" })
      expect(refusal(result)).toContain("DAILY_QUOTA_EXCEEDED")
      expect(refusal(result)).toContain("quota")
      expect(report.searches).toHaveLength(1)
    }).pipe(Effect.provide(harness({ seen: report, failure })))
  })

  it.live("turns a name the cache never saw into a refusal that names the way out", () => {
    const report = seen()
    return Effect.gen(function* () {
      const tools = yield* Tool.Service

      const result = yield* run(tools, "call-not-found", { action: "get", id: "nano-pdf-does-not-exist" })

      expect(result).toMatchObject({ status: "error" })
      expect(refusal(result)).toContain("nano-pdf-does-not-exist")
      expect(refusal(result)).toContain("Search first")
      expect(report.reads).toEqual(["nano-pdf-does-not-exist"])
    }).pipe(Effect.provide(harness({ seen: report })))
  })

  it.live("never reaches the catalog when permission refused the call", () => {
    const report = seen()
    return Effect.gen(function* () {
      const tools = yield* Tool.Service

      const result = yield* run(tools, "call-denied", { action: "search", query: "pdf" })

      expect(result).toMatchObject({ status: "error" })
      expect(refusal(result)).toContain("Permission refused by the test")
      expect(report.searches).toEqual([])
      expect(report.asked).toEqual(["skillsmp_search_skills:search_skills"])
    }).pipe(Effect.provide(harness({ seen: report }, "blocked")))
  })

  it.live("gives the model the reason when a refusal carries feedback", () => {
    const report = seen()
    return Effect.gen(function* () {
      const tools = yield* Tool.Service

      const result = yield* run(tools, "call-corrected", { action: "search", query: "pdf" })

      expect(result).toMatchObject({ status: "error" })
      // A CorrectedError has an empty `message` by design, so its feedback is the only text the
      // model can learn from. Without the leaf's branch this reads as a bare prefix.
      expect(refusal(result)).toBe(FEEDBACK)
      expect(report.searches).toEqual([])
    }).pipe(Effect.provide(harness({ seen: report }, "corrected")))
  })

  it.live("is blocked by a deny rule aimed at the old MCP server name, not only at the tool", () => {
    const report = seen()
    return Effect.gen(function* () {
      const tools = yield* Tool.Service
      yield* seedRules([{ action: "skillsmp_*", resource: "*", effect: "deny" }])

      const result = yield* run(tools, "call-deny-rule", { action: "search", query: "pdf" })

      expect(result).toMatchObject({ status: "error" })
      expect(refusal(result)).toContain("skillsmp_search_skills")
      expect(report.searches).toEqual([])
    }).pipe(Effect.provide(guardedHarness(report)))
  })

  it.live("still answers a get the search rule does not deny", () => {
    const report = seen()
    return Effect.gen(function* () {
      const tools = yield* Tool.Service
      yield* seedRules([
        { action: "*", resource: "*", effect: "deny" },
        { action: "skillsmp_search_skills", resource: "*", effect: "deny" },
        { action: "skillsmp_get_skill", resource: "*", effect: "allow" },
        { action: "skill_catalog", resource: "*", effect: "allow" },
      ])

      const refused = yield* run(tools, "call-rule-search", { action: "search", query: "pdf" })
      const allowed = yield* run(tools, "call-rule-get", { action: "get", id: "nano-pdf" })

      expect(refused).toMatchObject({ status: "error" })
      expect(allowed).toMatchObject({ status: "completed" })
      expect(report.reads).toEqual(["nano-pdf"])
    }).pipe(Effect.provide(guardedHarness(report)))
  })

  it.live("is blocked by a deny rule aimed at the wrapper tool itself", () => {
    const report = seen()
    return Effect.gen(function* () {
      const tools = yield* Tool.Service
      // The legacy name is allowed so the refusal can only have come from the wrapper rule.
      yield* seedRules([
        { action: "*", resource: "*", effect: "deny" },
        { action: "skillsmp_get_skill", resource: "*", effect: "allow" },
        { action: "skill_catalog", resource: "*", effect: "deny" },
      ])

      const result = yield* run(tools, "call-rule-wrapper", { action: "get", id: "nano-pdf" })

      expect(result).toMatchObject({ status: "error" })
      expect(refusal(result)).toContain("skill_catalog")
      expect(report.reads).toEqual([])
    }).pipe(Effect.provide(guardedHarness(report)))
  })

  it.live("keeps a skill for good only when the model asks for it, and asks permission first", () => {
    const report = seen()
    return Effect.gen(function* () {
      const tools = yield* Tool.Service

      const result = yield* run(tools, "call-global", { action: "get", id: "nano-pdf", save: "global" })

      expect(result).toMatchObject({ status: "completed" })
      // A write outside this project is a separate decision and carries its own check, after the
      // tool's own two, so a rule that denies the catalog does not silently write to disk.
      expect(report.asked).toEqual(["skillsmp_get_skill:get_skill", "skill_catalog:get_skill", "skill:nano-pdf"])
      expect(report.kept).toEqual(["nano-pdf"])
      expect((result.output as { saved: string }).saved).toBe("/home/user/.config/opencode/skills/nano-pdf/SKILL.md")
    }).pipe(Effect.provide(harness({ seen: report })))
  })

  it.live("a blocked global save leaves the skill in the project only", () => {
    const report = seen()
    const layer = AppNodeBuilder.build(
      LayerNode.group([
        Tool.node,
        makeLocationNode({
          name: "test/skill-catalog-plugin",
          layer: Layer.effectDiscard(registerToolPlugin(SkillCatalogTool.Plugin)),
          deps: [Tool.node, SkillMarketplace.node, Permission.node],
        }),
      ]),
      [
        Location.node.replace(
          Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make("/project") }))),
        ),
        Permission.node.replace(
          permissionLayer({
            assert: (input) => {
              report.asked.push(`${input.action}:${input.resources.join(",")}`)
              report.saves.push(grant(input))
              return input.action !== "skill"
                ? Effect.void
                : Effect.fail(
                    new Permission.BlockedError({
                      rules: [],
                      permission: input.action,
                      resources: input.resources,
                      reason: "Permission refused by the test",
                    }),
                  )
            },
          }),
        ),
        SkillMarketplace.node.replace(catalog({ seen: report })),
      ],
    )
    return Effect.gen(function* () {
      const tools = yield* Tool.Service

      const result = yield* run(tools, "call-global-denied", { action: "get", id: "nano-pdf", save: "global" })

      expect(result).toMatchObject({ status: "error" })
      expect(refusal(result)).toContain("Permission refused by the test")
      // The registry check stopped it: nothing was written outside the project.
      expect(report.kept).toEqual([])
    }).pipe(Effect.provide(layer))
  })

  test("puts the feedback in the failure's own text, not only in the cause it carries", () => {
    // The session error already unwraps a cause to `permission.rejected` with the feedback, so the
    // model was never left with the empty message. What the leaf must still get right is the
    // ToolFailure it produces: its own text is what logs and any future unwrap path read.
    const failure = SkillCatalogTool.failed(new Permission.CorrectedError({ feedback: FEEDBACK }))

    expect(failure).toBeInstanceOf(ToolFailure)
    expect(failure.message).toBe(FEEDBACK)
  })

  it.live("keeps an always answer, so the next call of the same kind asks nothing", () => {
    const report = seen()
    return Effect.gen(function* () {
      const tools = yield* Tool.Service
      const bus = yield* Bus.Service
      const permission = yield* Permission.Service
      const saved = yield* PermissionSaved.Service
      // No rules at all: `evaluate` falls back to ask, which is the state this tool meets on a
      // machine where nobody wrote a rule for it yet.
      yield* seedRules([])
      const asked: Permission.Request[] = []
      // Answered the way a person can: the dialog only offers "always" because `save` was set.
      const unsubscribe = yield* bus.listen((event) => {
        if (event.type !== Permission.Event.Asked.type) return Effect.void
        const request = event.data as Permission.Request
        return Effect.sync(() => asked.push(request)).pipe(
          Effect.flatMap(() => permission.reply({ requestID: request.id, reply: "always" })),
          Effect.catchTag("Permission.NotFoundError", () => Effect.void),
        )
      })
      yield* Effect.addFinalizer(() => unsubscribe)

      const first = yield* Effect.forkScoped(run(tools, "call-always-1", { action: "search", query: "pdf" }))
      yield* Fiber.join(first)

      expect(asked.map((request) => `${request.action}:${(request.save ?? []).join(",")}`)).toEqual([
        "skillsmp_search_skills:search_skills",
        "skill_catalog:search_skills",
      ])
      // Compared as a set: the store does not promise an order, and the pair is what matters.
      expect(
        (yield* saved.list({ projectID: Project.ID.global }))
          .map((rule) => `${rule.action}:${rule.resource}`)
          .toSorted(),
      ).toEqual(["skill_catalog:search_skills", "skillsmp_search_skills:search_skills"])

      const second = yield* run(tools, "call-always-2", { action: "search", query: "pdf" })

      expect(second).toMatchObject({ status: "completed" })
      expect(report.searches).toHaveLength(2)
      // No third prompt: the two saved rules answer both asserts on their own.
      expect(asked).toHaveLength(2)
    }).pipe(Effect.provide(guardedHarness(report)))
  })

  test("names the permission strings a saved rule already uses", () => {
    // These two names are why the checks still carry them: the user has saved rules for them from
    // when this tool called the MCP server, and a rule that silently stopped matching is a rule
    // the user believes is protecting them and is not.
    expect(SkillCatalogTool.description).toContain(McpTool.name(SkillCatalogTool.server, "search_skills"))
    expect(SkillCatalogTool.description).toContain(McpTool.name(SkillCatalogTool.server, "get_skill"))
  })

  test("tells the model that the project caches what it has seen, and that keeping is explicit", () => {
    // The two promises the model acts on: a repeated search costs nothing, and a skill is kept
    // for good only when asked for.
    expect(SkillCatalogTool.description).toContain("cached inside it")
    expect(SkillCatalogTool.description).toContain('save: "global"')
    expect(SkillCatalogTool.description).toContain("only happens when you pass")
  })

  test("is registered in the internal pre list, the only place production loads it from", async () => {
    // A source check on purpose: deleting the line from `pre` leaves every other test green,
    // because they all register the plugin themselves.
    const source = await Bun.file(new URL("../src/plugin/internal.ts", import.meta.url)).text()
    const pre = /const pre = \[([\s\S]*?)\n\] as const/.exec(source)?.[1]

    expect(pre).not.toBeUndefined()
    expect(pre).toContain("SkillCatalogTool.Plugin")
    expect(source).toContain('import { SkillCatalogTool } from "../tool/plugin/skill-catalog.js"')
  })

  it.live("advertises itself on the model tool list, not only inside CodeMode", () => {
    const report = seen()
    return Effect.gen(function* () {
      const tools = yield* Tool.Service

      const snapshot = yield* tools.snapshot()

      expect(snapshot.definitions.map((definition) => definition.name)).toContain(SkillCatalogTool.name)
      // codemode:false keeps it off the catalog the model would otherwise have to dig through.
      expect(codeModeListings(snapshot.codeModeCatalog!).map((entry) => entry.path)).not.toContain(
        SkillCatalogTool.name,
      )
    }).pipe(Effect.provide(harness({ seen: report })))
  })
})
