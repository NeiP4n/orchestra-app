export * as SkillMarketplaceNative from "./native.js"

import path from "path"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { Global } from "@orchestra/util/global"
import { makeLocationNode } from "@orchestra/util/effect/app-node"
import { Location } from "../location.js"
import { SkillMarketplaceLevels } from "./levels.js"
import { SkillMarketplaceManifest } from "./manifest.js"
import { SkillMarketplaceRules } from "./rules.js"
import { SkillMarketplaceFactory } from "./factory.js"
import { SkillMarketplacePick } from "./pick.js"
import { Budget, BudgetExceeded, estimateTokens } from "./budget.js"
import type { Factory, Level, Manifest, NativeSkill, SkillRef, ValueVerdict } from "./types.js"

/**
 * The native marketplace service: the in-Orchestra counterpart to the
 * upstream catalog service in `index.ts`. The catalog service answers "what
 * exists out there"; this one answers "what is installed here, at which
 * level, and how do the pieces fit into a working factory".
 *
 * The rules that bind a skill are passed in by the caller (they live in the
 * Rules store, `packages/core/src/rules.ts`); the marketplace never owns
 * them, it only enforces them. The token budget is created fresh per
 * request by the caller and handed in, so one request can never spend
 * another's budget.
 */

export class InstallError extends Schema.TaggedError<InstallError>()("@orchestra/SkillMarketplace/InstallError", {
  message: Schema.String,
}) {}

export class LoadError extends Schema.TaggedError<LoadError>()("@orchestra/SkillMarketplace/LoadError", {
  message: Schema.String,
}) {}

export type ScopeRule = { readonly text: string; readonly level: Level }

export interface LoadedSkill {
  readonly name: string
  readonly level: Level
  /** The skill's text with its binding rules prepended. */
  readonly content: string
  /** Estimated tokens this load cost against the request's budget. */
  readonly tokens: number
}

export interface Interface {
  /** Installs a skill's text at a level, after the manifest, scan and rule checks. */
  readonly install: (input: {
    content: string
    level: Level
    source: string
    rules: readonly ScopeRule[]
  }) => Effect.Effect<NativeSkill, InstallError>
  /** Removes a skill from a level. */
  readonly uninstall: (name: string, level: Level) => Effect.Effect<void, InstallError>
  /** The skills installed at one level. */
  readonly list: (level: Level) => Effect.Effect<readonly NativeSkill[]>
  /** The skills visible to a session: society, project, session, with shadowing. */
  readonly effective: () => Effect.Effect<readonly NativeSkill[]>
  /** The compact index of the effective skills: refs only, never full text. */
  readonly index: () => Effect.Effect<readonly SkillRef[]>
  /** The prompt-intake entry point: pick skills for a task from the compact index. */
  readonly pick: (input: {
    goal: string
    context?: string
    outputs?: readonly { name: string; type: "text" | "json" | "list" | "file" | "code" | "plan" | "report" }[]
    inputs?: readonly { name: string; type: "text" | "json" | "list" | "file" | "code" | "plan" | "report" }[]
    value?: ValueVerdict
    maxSkills?: number
  }) => Effect.Effect<SkillMarketplacePick.Picked>
  /** Assembles a factory for a goal from the effective skills. */
  readonly composeFactory: (goal: SkillMarketplaceFactory.Goal) => Effect.Effect<Factory, InstallError>
  /**
   * Lazily loads one skill's text: the only call that reads a SKILL.md.
   * Refuses with `BudgetExceeded` when the text would pass the request's
   * budget, and records the use in the journal.
   */
  readonly loadSkill: (input: {
    name: string
    budget: Budget
    rules: readonly ScopeRule[]
    task: string
  }) => Effect.Effect<LoadedSkill, LoadError | BudgetExceeded>
}

export class Service extends Context.Service<Service, Interface>()("@orchestra/SkillMarketplaceNative") {}

export interface LayerOptions {
  readonly roots: SkillMarketplaceLevels.Roots
}

export const layerWith = (options: LayerOptions) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const roots = options.roots
      const contentPath = (level: Level, name: string) =>
        path.join(rootsOf(roots, level) ?? "", SkillMarketplaceLevels.REGISTRY_DIR, "skills", name, "SKILL.md")

      return Service.of({
        install: Effect.fn("SkillMarketplaceNative.install")(function* (input) {
          const parsed = SkillMarketplaceManifest.parse(input.content)
          if (parsed.manifest === undefined && parsed.errors.length > 0)
            return yield* new InstallError({
              message: `The skill has a broken manifest: ${parsed.errors.join(" ")}`,
            })
          const manifest: Manifest =
            parsed.manifest ?? SkillMarketplaceManifest.derive(slugOf(input.source), input.content)
          const check = SkillMarketplaceRules.checkInstall(manifest, input.content, input.rules)
          if (!check.ok) return yield* new InstallError({ message: check.reason })
          if (check.journal !== undefined) yield* SkillMarketplaceLevels.appendJournal(roots, input.level, check.journal)
          const target = contentPath(input.level, manifest.name)
          yield* Effect.tryPromise({
            try: async () => {
              const { mkdir, writeFile } = await import("node:fs/promises")
              await mkdir(path.dirname(target), { recursive: true })
              await writeFile(target, input.content.endsWith("\n") ? input.content : `${input.content}\n`)
            },
            catch: (error) => new InstallError({ message: `the skill text could not be written: ${text(error)}` }),
          })
          const skill: NativeSkill = { manifest, level: input.level, source: input.source, contentPath: target }
          yield* SkillMarketplaceLevels.install(roots, skill).pipe(
            Effect.mapError((error) => new InstallError({ message: error.message })),
          )
          return skill
        }),

        uninstall: Effect.fn("SkillMarketplaceNative.uninstall")(function* (name, level) {
          yield* SkillMarketplaceLevels.uninstall(roots, name, level).pipe(
            Effect.mapError((error) => new InstallError({ message: error.message })),
          )
        }),

        list: (level) => SkillMarketplaceLevels.loadLevel(roots, level),

        effective: () => SkillMarketplaceLevels.effective(roots),

        index: () =>
          SkillMarketplaceLevels.effective(roots).pipe(Effect.map((skills) => SkillMarketplaceLevels.compactIndex(skills))),

        pick: Effect.fn("SkillMarketplaceNative.pick")(function* (input) {
          const skills = yield* SkillMarketplaceLevels.effective(roots)
          return SkillMarketplacePick.pickSkillsForTask(
            {
              goal: input.goal,
              context: input.context,
              index: SkillMarketplaceLevels.compactIndex(skills),
              outputs: input.outputs,
              inputs: input.inputs,
              value: input.value,
              maxSkills: input.maxSkills,
            },
            skills,
          )
        }),

        composeFactory: Effect.fn("SkillMarketplaceNative.composeFactory")(function* (goal) {
          const skills = yield* SkillMarketplaceLevels.effective(roots)
          const composed = SkillMarketplaceFactory.compose(goal, skills)
          if (!composed.ok) return yield* new InstallError({ message: composed.reason })
          for (const entry of composed.journal) yield* SkillMarketplaceLevels.appendJournal(roots, "project", entry)
          return composed.factory
        }),

        loadSkill: Effect.fn("SkillMarketplaceNative.loadSkill")(function* (input) {
          const skills = yield* SkillMarketplaceLevels.effective(roots)
          const skill = skills.find((entry) => entry.manifest.name === input.name)
          if (skill === undefined)
            return yield* new LoadError({ message: `No installed skill is called "${input.name}".` })
          const text = yield* Effect.tryPromise({
            try: () => Bun.file(skill.contentPath).text(),
            catch: () => undefined,
          }).pipe(
            Effect.option,
            Effect.map((option) => (Option.isSome(option) ? option.value : undefined)),
          )
          if (text === undefined)
            return yield* new LoadError({ message: `The text of skill "${input.name}" is missing at ${skill.contentPath}.` })
          const check = SkillMarketplaceRules.checkInstall(skill.manifest, text, input.rules)
          if (!check.ok)
            return yield* new LoadError({ message: `Skill "${input.name}" no longer passes its checks: ${check.reason}` })
          const tokens = estimateTokens(text)
          if (input.budget.check(tokens) === "stop")
            return yield* new BudgetExceeded({
              message: `Loading skill "${input.name}" would cost ~${tokens} tokens, but only ${input.budget.remaining()} of ${input.budget.total} remain for this request.`,
              spent: input.budget.spent(),
              budget: input.budget.total,
            })
          const verdict = input.budget.spend(tokens)
          if (verdict === "warn")
            yield* Effect.logWarning("skill load near the token budget", {
              skill: input.name,
              spent: input.budget.spent(),
              budget: input.budget.total,
            })
          const content = `${SkillMarketplaceRules.injectionBlock(skill.manifest, input.rules)}\n${text}`
          yield* SkillMarketplaceLevels.recordUsage(roots, {
            skill: skill.manifest.name,
            level: skill.level,
            task: input.task,
            outcome: "done",
            tokens,
            at: Date.now(),
          })
          return { name: skill.manifest.name, level: skill.level, content, tokens }
        }),
      })

      function rootsOf(roots: SkillMarketplaceLevels.Roots, level: Level): string | undefined {
        return level === "society" ? roots.society : level === "project" ? roots.project : roots.session
      }

      function slugOf(source: string): string {
        const slug = source
          .replace(/^.*[/:]/, "")
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "")
        return slug === "" ? "skill" : slug
      }

      function text(error: unknown) {
        return error instanceof globalThis.Error ? error.message : String(error)
      }
    }),
  )

/** The production layer: project from Location, society and session from the environment when set. */
export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const location = yield* Location.Service
    return layerWith({
      roots: {
        society: process.env.ORCHESTRA_SOCIETY_ROOT,
        project: location.directory,
        session: process.env.ORCHESTRA_SESSION_ROOT,
      },
    })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [Global.node, Location.node] })
