export * as SkillMarketplace from "./index.js"

import path from "path"
import { Context, Effect, Layer, Option, Ref } from "effect"
import { Global } from "@orchestra/util/global"
import { makeLocationNode } from "@orchestra/util/effect/app-node"
import { Location } from "../location.js"
import { SkillMarketplaceRead } from "./read.js"
import { SkillMarketplaceSave } from "./save.js"
import { SkillMarketplaceSearch } from "./search.js"
import { SkillMarketplaceStore } from "./store.js"
import { SkillMarketplaceUpstream } from "./upstream.js"

export {
  SkillMarketplaceRead,
  SkillMarketplaceSave,
  SkillMarketplaceSearch,
  SkillMarketplaceStore,
  SkillMarketplaceUpstream,
}

export type SearchInput = SkillMarketplaceSearch.Input
export type ReadInput = {
  /** The bare name from a search row, which is how a caller refers to a skill afterwards. */
  readonly name: string
}

export interface SearchResult {
  readonly hits: SkillMarketplaceSearch.Hit[]
  /** True when the answer came from this project's cache and no request left the machine. */
  readonly cached: boolean
  /** Set when the cache file exists but could not be read; the answer still stands. */
  readonly damage: string | undefined
}

export interface ReadResult {
  readonly name: string
  readonly content: string
  readonly truncated: boolean
  /** Where the text came from: GitHub, or the copy already in this project. */
  readonly source: string
  /** The file written into this project, or `undefined` when it was already there. */
  readonly applied: string | undefined
}

export interface SaveResult extends SkillMarketplaceSave.Result {}

export interface Stats {
  readonly cached: number
  readonly degraded: boolean
  readonly damage: string | undefined
  readonly updatedAt: number | undefined
  readonly directory: string
}

export type Failure =
  | SkillMarketplaceUpstream.UpstreamError
  | SkillMarketplaceRead.ReadError
  | SkillMarketplaceSave.SaveError
  | SkillMarketplaceStore.StoreError

export interface Interface {
  /**
   * Answers from this project's cache when it can. A query that hits something already cached
   * never reaches the network, which is what makes asking the catalog free; a query that hits
   * nothing is sent upstream and its rows are cached for the next time.
   */
  readonly search: (input: SearchInput) => Effect.Effect<SearchResult, Failure>
  /**
   * The text of one skill: from the copy already applied in this project when there is one, and
   * from GitHub otherwise. The text is always left in the project afterwards.
   */
  readonly read: (input: ReadInput) => Effect.Effect<ReadResult, Failure>
  /** Keeps the skill for good, in the global registry. Nothing else here ever calls this. */
  readonly save: (input: ReadInput) => Effect.Effect<SaveResult, Failure>
  /** What this project has cached and whether that cache is trustworthy. */
  readonly stats: Effect.Effect<Stats>
}

export class Service extends Context.Service<Service, Interface>()("@orchestra/SkillMarketplace") {}

/**
 * Where the two transports come from. Production uses the platform fetch; a test injects its own,
 * which is the only way to exercise the cache without letting a test reach the catalog.
 */
export interface LayerOptions {
  readonly catalog?: SkillMarketplaceUpstream.Fetch
  readonly github?: typeof globalThis.fetch
  /** Extra transport options, merged over the defaults; tests use it to drop the rate pause. */
  readonly upstream?: SkillMarketplaceUpstream.Options
}

/** What is in memory: the rows, their postings, and when the file was written. */
interface Loaded {
  readonly index: SkillMarketplaceStore.Index
  readonly postings: SkillMarketplaceSearch.Postings
  readonly meta: SkillMarketplaceStore.Meta
}

export const layerWith = (options: LayerOptions = {}) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const location = yield* Location.Service
      const global = yield* Global.Service
      const directory = path.join(location.directory, SkillMarketplaceStore.DIRECTORY)
      const projectSkills = path.join(location.directory, SkillMarketplaceRead.PROJECT_DIRECTORY)
      const globalSkills = path.join(global.config, SkillMarketplaceSave.GLOBAL_DIRECTORY)
      // Nothing is read until something asks for it: a session that never touches the catalog
      // pays nothing for having one.
      const held = yield* Ref.make(Option.none<Loaded>())

      /**
       * The file is the source of truth; this is a cache of it. The postings are built once per
       * load rather than per query, which is the whole reason the cache pays for itself: a search
       * is then memory lookups over rows that never leave the machine.
       */
      const current = Effect.fn("SkillMarketplace.current")(function* () {
        const cached = yield* Ref.get(held)
        if (Option.isSome(cached)) return cached.value
        const [index, meta] = yield* Effect.all([
          SkillMarketplaceStore.load(directory),
          SkillMarketplaceStore.loadMeta(directory),
        ])
        const loaded: Loaded = { index, postings: SkillMarketplaceSearch.build(index.skills), meta }
        yield* Ref.set(held, Option.some(loaded))
        return loaded
      })

      const store = (skills: Map<SkillMarketplaceStore.SkillID, SkillMarketplaceStore.Skill>, now: () => number) =>
        SkillMarketplaceStore.save(skills, { updatedAt: now() }, directory).pipe(
          // The write replaced the rows; dropping the cache is what makes the next search see them.
          Effect.tap(() => Ref.set(held, Option.none())),
        )

      const text = (githubUrl: string) =>
        SkillMarketplaceRead.read(githubUrl, options.github === undefined ? {} : { fetch: options.github })

      return Service.of({
        search: Effect.fn("SkillMarketplace.search")(function* (input) {
          const state = yield* current()
          // A category or an order cannot be answered from cached rows: the cache holds no
          // category and ranks by score and stars. Asking for one is therefore an upstream call by
          // definition, rather than a cache answer that quietly ignored the filter.
          const offline = input.category === undefined && input.sortBy === undefined
          const known = offline ? SkillMarketplaceSearch.search(input, state.index, state.postings) : []
          if (known.length > 0) return { hits: known, cached: true, damage: state.index.damage }
          const listing = yield* SkillMarketplaceUpstream.search(
            {
              query: input.query,
              ...(input.limit === undefined ? {} : { limit: input.limit }),
              ...(input.category === undefined ? {} : { category: input.category }),
              ...(input.language === undefined ? {} : { language: input.language }),
              ...(input.sortBy === undefined ? {} : { sortBy: input.sortBy }),
            },
            { ...options.upstream, ...(options.catalog === undefined ? {} : { fetch: options.catalog }) },
          )
          const skills = new Map(state.index.skills)
          // Keyed by the catalog's own id, so the same skill reached by two queries is stored once.
          for (const skill of listing.data.skills) skills.set(skill.id, skill)
          yield* store(skills, Date.now)
          return {
            hits: SkillMarketplaceSearch.search(
              input,
              { ...state.index, skills },
              SkillMarketplaceSearch.build(skills),
            ),
            cached: false,
            damage: state.index.damage,
          }
        }),

        read: Effect.fn("SkillMarketplace.read")(function* (input) {
          const row = yield* resolve(input.name)
          if (row === undefined)
            return yield* new SkillMarketplaceRead.ReadError({
              message: `The catalog cache holds no skill called "${input.name}". Search first, and use a name from the results.`,
            })
          const applied = SkillMarketplaceRead.appliedPath(projectSkills, row.name)
          const local = applied === undefined ? undefined : yield* localText(applied)
          if (applied !== undefined && local !== undefined)
            return { name: row.name, content: local, truncated: false, source: applied, applied: undefined }
          const fetched = yield* text(row.githubUrl)
          // Left in the project either way: the next read of this skill is then a file read.
          const written = yield* SkillMarketplaceRead.apply(projectSkills, row.name, fetched.content)
          return {
            name: row.name,
            content: fetched.content,
            truncated: fetched.truncated,
            source: fetched.url,
            applied: written,
          }
        }),

        save: Effect.fn("SkillMarketplace.save")(function* (input) {
          const row = yield* resolve(input.name)
          if (row === undefined)
            return yield* new SkillMarketplaceSave.SaveError({
              message: `The catalog cache holds no skill called "${input.name}". Search first, and use a name from the results.`,
            })
          const applied = SkillMarketplaceRead.appliedPath(projectSkills, row.name)
          const local = applied === undefined ? undefined : yield* localText(applied)
          const content = local ?? (yield* text(row.githubUrl)).content
          return yield* SkillMarketplaceSave.save(globalSkills, row.name, content)
        }),

        stats: current().pipe(
          Effect.map((state) => ({
            cached: state.index.skills.size,
            degraded: state.index.degraded,
            damage: state.index.damage,
            updatedAt: state.meta.updatedAt,
            directory,
          })),
        ),
      })

      /** The row behind a bare name, by the name itself or by the id the catalog gives it. */
      function* resolve(name: string) {
        const state = yield* current()
        const byName = [...state.index.skills.values()].find((skill) => skill.name === name)
        if (byName !== undefined) return byName
        return state.index.skills.get(name as SkillMarketplaceStore.SkillID)
      }

      /** A missing file is the normal case here, so a read that fails answers `undefined`. */
      function localText(target: string) {
        return Effect.tryPromise({ try: () => Bun.file(target).text(), catch: () => undefined }).pipe(
          Effect.result,
          Effect.map((result) => (result._tag === "Success" ? result.success : undefined)),
        )
      }
    }),
  )

const layer = layerWith()

export const node = makeLocationNode({ service: Service, layer, deps: [Global.node, Location.node] })
