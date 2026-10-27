export * as SkillCatalogTool from "./skill-catalog.js"

import { ToolFailure } from "@orchestra/ai"
import type { Context } from "@orchestra/plugin/effect/plugin"
import { SkillMarketplace as Catalog } from "@orchestra/schema/skill-marketplace"
import type { Tool } from "@orchestra/schema/tool"
import { Effect, Schema } from "effect"
import { McpTool } from "../mcp.js"
import { Permission } from "../../permission.js"
import { SkillMarketplace } from "../../skill-marketplace/index.js"
import { SkillMarketplaceUpstream } from "../../skill-marketplace/upstream.js"

export const name = "skill_catalog"

/**
 * The server whose rules this tool inherits. Nothing here talks to that server any more, but the
 * permission strings below keep its name because the user's saved rules do: a "never allow
 * skillsmp_search_skills" or "always allow skillsmp_get_skill" rule was written while this tool
 * called the MCP server, and renaming the resource would silently stop it applying.
 */
export const server = "skillsmp"

/**
 * Marketplace hits are metadata, not instructions: the cap keeps a broad query from filling
 * the context before the model has chosen one skill. The catalog allows 50, the tool does not.
 */
export const MAX_RESULTS = 10
const DEFAULT_RESULTS = 5
/** A cold marketplace query plus a dead cache can wait forever; past this the model gets a refusal. */
const CALL_TIMEOUT = "20 seconds"
const DESCRIPTION_LIMIT = 200
/** Nothing the model reads from a catalog hit needs more text than this. */
const RAW_LIMIT = 4000

export const description = [
  "Search the SkillsMP marketplace for ready-made agent skills, scan them for danger, read one skill's text, and keep a skill for good.",
  "",
  "Use the skill tool for skills already installed on this machine; use this one when nothing local fits the task and a published skill might.",
  "",
  "What this project has already seen is cached inside it, so a repeated search costs no request at all and works with no network.",
  "",
  "Actions:",
  `  search — find skills by words in query (required), up to ${MAX_RESULTS} results (${DEFAULT_RESULTS} by default); narrow with category or language, and order by stars or recent. A category or an order always asks the catalog.`,
  "  scan — a static security scan (SkillSpector-style rules) of one skill by id (required), with nothing written to the project. Scan the candidates you are considering BEFORE you get one.",
  '  get — the full text of one skill, by the bare name from a search row in id (required). The text is saved into this project, so reading it again costs no request. Add save: "global" to keep the skill for good in every project.',
  "",
  "get and save scan the skill themselves and refuse one that scores DO NOT INSTALL, so a dangerous skill is never written to disk. A scan reads only SKILL.md: SAFE means no known bad pattern in that text, not that the skill's scripts were checked. Tell the user the score and findings when you recommend a skill, and never install one flagged CAUTION without saying why.",
  "",
  'Keeping a skill globally is the user\'s decision and only happens when you pass save: "global".',
  `Permission: each call is checked under the old MCP tool name (${McpTool.name(server, "search_skills")}, ${McpTool.name(server, "get_skill")}), the name a saved rule for that server already uses, and under ${name}. A write into the global skills directory is additionally checked under the skill registry.`,
].join("\n")

export const Input = Schema.Struct({
  action: Schema.Literals(["search", "scan", "get"]).annotate({
    description: "Search the marketplace for skills, scan one found skill for danger, or read and install one",
  }),
  query: Schema.optionalKey(Schema.String).annotate({
    description: "A few words naming the task, for search",
  }),
  id: Schema.optionalKey(Schema.String).annotate({
    description: "Exact skill name or slug from a search result, for scan and get",
  }),
  limit: Schema.optionalKey(Schema.Number).annotate({
    description: `How many results search returns, 1 to ${MAX_RESULTS}`,
  }),
  category: Schema.optionalKey(Schema.String).annotate({
    description: "Category slug for search, for example data-ai, devops, web-development",
  }),
  language: Schema.optionalKey(Schema.String).annotate({
    description: "Content language code for search, for example en, zh, ja, ru",
  }),
  sort: Schema.optionalKey(Schema.Literals(["stars", "recent"])).annotate({
    description: "Result order for search, most starred first by default",
  }),
  save: Schema.optionalKey(Schema.Literals(["global"])).annotate({
    description:
      "With get: also keep this skill for good in every project. Omit it and the skill stays in this project only.",
  }),
})
export type Input = typeof Input.Type

const Finding = Schema.Struct({
  rule: Schema.String,
  category: Schema.String,
  severity: Schema.String,
  line: Schema.Number,
  excerpt: Schema.String,
  message: Schema.String,
})

const Skill = Schema.Struct({
  name: Schema.String,
  stars: Schema.optionalKey(Schema.Number),
  description: Schema.optionalKey(Schema.String),
  url: Schema.optionalKey(Schema.String),
})

export const Output = Schema.Struct({
  output: Schema.String,
  action: Schema.Literals(["search", "scan", "get"]),
  /** The scan's risk score, 0 to 100, for scan and get. */
  score: Schema.optionalKey(Schema.Number),
  recommendation: Schema.optionalKey(Schema.String),
  findings: Schema.optionalKey(Schema.Array(Finding)),
  reported: Schema.optionalKey(Schema.Number),
  skills: Schema.optionalKey(Schema.Array(Skill)),
  truncated: Schema.optionalKey(Schema.Boolean),
  /** Where this project's copy of a read skill lives, or where a global copy was written. */
  saved: Schema.optionalKey(Schema.String),
  /** True when the answer came from the project's cache and no request was made. */
  cached: Schema.optionalKey(Schema.Boolean),
})
export type Output = typeof Output.Type

const EMPTY = "The skill catalog returned no text."

/**
 * The catalog's own language set, read from the contract instead of a list written out here: its
 * `enum` is the same closed set (measured live 2026-10-15), and a second copy would drift from it.
 */
const isLanguage = Schema.is(Catalog.ContentLanguage)

const clip = (text: string, limit: number) => (text.length <= limit ? text : `${text.slice(0, limit - 1)}…`)

const results = (wanted: unknown) =>
  typeof wanted === "number" && Number.isFinite(wanted)
    ? Math.min(Math.max(Math.round(wanted), 1), MAX_RESULTS)
    : DEFAULT_RESULTS

/** What one input means once its arguments are validated, before anything is asked of anyone. */
type Call =
  | {
      readonly action: "search"
      readonly input: SkillMarketplace.SearchInput
      readonly resource: string
    }
  | { readonly action: "scan"; readonly name: string; readonly resource: string }
  | {
      readonly action: "get"
      readonly name: string
      readonly global: boolean
      readonly resource: string
    }

const call = (input: Input): Effect.Effect<Call, ToolFailure> => {
  if (input.action === "scan") {
    if (input.id === undefined)
      return Effect.fail(new ToolFailure({ message: "skill_catalog scan needs id: the skill name from a search" }))
    return Effect.succeed({ action: "scan", name: input.id, resource: "get_skill" })
  }
  if (input.action === "get") {
    if (input.id === undefined)
      return Effect.fail(new ToolFailure({ message: "skill_catalog get needs id: the skill name from a search" }))
    return Effect.succeed({ action: "get", name: input.id, global: input.save === "global", resource: "get_skill" })
  }
  // A blank query is refused here rather than forwarded. The catalog's own schema refuses one
  // (`minLength: 1`, `pattern: .*\S.*`, measured live 2026-10-15): the call would come back as a
  // rejection of the input rather than as an answer, and the model would read that as the
  // catalog having no skills for the task.
  if (input.query === undefined || input.query.trim() === "")
    return Effect.fail(new ToolFailure({ message: "skill_catalog search needs query: a few words naming the task" }))
  // `language` is a closed set of codes on the catalog side, and the tool's schema only declares
  // a string. A code outside the set fails the whole call, so it is refused here with examples
  // the model can correct itself from.
  if (input.language !== undefined && !isLanguage(input.language))
    return Effect.fail(
      new ToolFailure({
        message: `skill_catalog search does not know the language code "${input.language}". Use a code from the catalog's list, for example en, zh, ja, de, fr, ru, rus.`,
      }),
    )
  return Effect.succeed({
    action: "search",
    input: {
      query: input.query,
      limit: results(input.limit),
      ...(input.category === undefined ? {} : { category: input.category }),
      ...(input.language === undefined ? {} : { language: input.language as Catalog.ContentLanguage }),
      ...(input.sort === undefined ? {} : { sortBy: input.sort }),
    },
    resource: "search_skills",
  })
}

/** One row as the model sees it: the catalog's own fields, bounded and trimmed. */
const shape = (skill: { name: string; stars: number; description: string; githubUrl: string }) => ({
  name: skill.name,
  stars: skill.stars,
  description: clip(skill.description, DESCRIPTION_LIMIT),
  url: skill.githubUrl,
})

const searched = (answer: SkillMarketplace.SearchResult): Output => {
  const skills = answer.hits.slice(0, MAX_RESULTS).map((hit) => shape(hit.skill))
  // An empty answer is an answer: the model must not read "nothing found" as a failure.
  if (skills.length === 0)
    return { action: "search", reported: 0, skills: [], cached: answer.cached, output: "No skill matched those words." }
  return {
    action: "search",
    reported: answer.hits.length,
    skills,
    cached: answer.cached,
    output: [
      `Found ${skills.length} skill${skills.length === 1 ? "" : "s"}${answer.cached ? " in this project's catalog cache" : ""}:`,
      ...skills.map((skill) =>
        [`- ${skill.name} (${skill.stars} stars)`, `  ${skill.description}`, `  ${skill.url}`].join("\n"),
      ),
    ].join("\n"),
  }
}

const MAX_FINDINGS = 20

const verdict = (report: SkillMarketplace.ReadResult["scan"]) => ({
  score: report.score,
  recommendation: report.recommendation,
  findings: report.findings.slice(0, MAX_FINDINGS),
})

/** A get also carries the skill text, so it shows fewer findings than a scan; the structured list holds all of them. */
const summary = (report: SkillMarketplace.ReadResult["scan"], shown = MAX_FINDINGS) =>
  [
    `Scan: ${report.score}/100 ${report.recommendation} (SKILL.md text only; scripts, dependencies and runtime behaviour are not checked).`,
    ...report.findings
      .slice(0, shown)
      .map((finding) => `- ${finding.severity} ${finding.rule} line ${finding.line}: ${finding.message} — ${finding.excerpt}`),
  ].join("\n")

const scanned = (answer: SkillMarketplace.ScanResult): Output => ({
  action: "scan",
  ...verdict(answer.scan),
  output: [
    `${answer.name}: ${summary(answer.scan)}`,
    ...(answer.truncated ? ["The text was cut at the read limit; the tail was not scanned."] : []),
  ].join("\n"),
})

const detailed = (answer: SkillMarketplace.ReadResult, global?: SkillMarketplace.SaveResult): Output => {
  const full = `${summary(answer.scan, 5)}\n\n${answer.content || EMPTY}`
  const clipped = full.length > RAW_LIMIT
  return {
    action: "get",
    ...verdict(answer.scan),
    output: clip(full, RAW_LIMIT),
    // An optional key that is present as `undefined` fails the output schema; it has to be absent.
    ...(clipped ? { truncated: true } : {}),
    ...(global === undefined && answer.applied === undefined ? {} : { saved: global?.path ?? answer.applied }),
  }
}

/**
 * The registry accepts only its own `Tool.Error`. A permission failure arrives typed and becomes
 * one, while a plain decline raised as a defect and interruption stay untouched. Exported so the
 * feedback contract below is checkable without reaching the model.
 */
export const failed = (error: unknown) => {
  if (error instanceof ToolFailure) return error
  // A decline carrying feedback has an empty `message` by design, so without this branch the
  // model would read "Skill catalog call failed: " and never learn what it got wrong.
  if (error instanceof Permission.CorrectedError) return new ToolFailure({ message: error.feedback, error })
  // The catalog's own code is the part a caller can act on, so it stays in the text. The
  // failure carries no `error`: the session prefers an unwrapped cause's own message over the
  // leaf's, and the model must read this sentence rather than the bare upstream one.
  if (error instanceof SkillMarketplaceUpstream.UpstreamError)
    return new ToolFailure({
      message: `The catalog refused the call${error.code === undefined ? "" : ` (${error.code})`}: ${error.message}`,
    })
  const message = error instanceof Error ? error.message : String(error)
  return new ToolFailure({ message: `Skill catalog call failed: ${message}`, error })
}

export const Plugin = {
  id: "orchestra.tool.skill_catalog",
  effect: Effect.fn("SkillCatalogTool.Plugin")(function* (ctx: Context) {
    const catalog = yield* SkillMarketplace.Service
    const permission = yield* Permission.Service

    const authorize = Effect.fn("SkillCatalogTool.authorize")(function* (
      context: Tool.Context,
      action: string,
      resource: string,
    ) {
      // `save` is what turns the prompt into a lasting rule: without it the dialog offers only
      // once/reject and an "always" is dropped on the floor. This saves the one resource the
      // call is about, which is narrower than the proxied MCP tool's "*" and enough to silence
      // this call's prompts for good.
      yield* permission.assert({
        action,
        resources: [resource],
        save: [resource],
        metadata: {},
        sessionID: context.sessionID,
        agent: context.agent,
        source: { type: "tool", messageID: context.messageID, id: context.id },
      })
    })

    yield* ctx.tool
      .transform((editor) =>
        editor.add({
          name,
          options: { codemode: false, triggers: ["skills?\\b|скилл|навык", "skillsmp"] },
          description,
          input: Input,
          output: Output,
          execute: (input, context) =>
            Effect.gen(function* () {
              const target = yield* call(input)
              const legacy =
                target.action === "search" ? McpTool.name(server, "search_skills") : McpTool.name(server, "get_skill")
              // Two rule surfaces, one check each. The old MCP name comes first: it is the name
              // a saved rule for this catalog already carries, so such a rule stops the call
              // before anything else is asked of the user.
              yield* authorize(context, legacy, target.resource)
              yield* authorize(context, name, target.resource)
              if (target.action === "search")
                return yield* catalog
                  .search(target.input)
                  .pipe(Effect.timeout(CALL_TIMEOUT), Effect.map(searched), Effect.mapError(failed))
              if (target.action === "scan")
                return yield* catalog
                  .scan({ name: target.name })
                  .pipe(Effect.timeout(CALL_TIMEOUT), Effect.map(scanned), Effect.mapError(failed))
              const read = yield* catalog
                .read({ name: target.name })
                .pipe(Effect.timeout(CALL_TIMEOUT), Effect.mapError(failed))
              if (!target.global) return detailed(read)
              // Keeping a skill writes outside this project, so it is checked under the skill
              // registry's own action before anything lands on disk.
              yield* authorize(context, "skill", read.name)
              const saved = yield* catalog.save({ name: target.name }).pipe(Effect.mapError(failed))
              return detailed(read, saved)
              // Permission declines and interruptions stay typed: this leaf never converts them.
            }).pipe(
              Effect.map((output) => ({ output, content: output.output })),
              Effect.mapError(failed),
            ),
        }),
      )
      .pipe(Effect.orDie)
  }),
}
