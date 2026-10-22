import { describe, expect, test } from "bun:test"
import path from "node:path"
import { Effect, Layer } from "effect"
import { Global } from "@orchestra/util/global"
import { makeLocationNode } from "@orchestra/util/effect/app-node"
import { AppNodeBuilder } from "@orchestra/core/effect/app-node-builder"
import { Location } from "@orchestra/core/location"
import { AbsolutePath } from "@orchestra/core/schema"
import { SkillMarketplace } from "@orchestra/core/skill-marketplace/index"
import { SkillMarketplaceStore } from "@orchestra/core/skill-marketplace/store"
import { LISTING_A, LISTING_C, QUOTA_REFUSAL } from "./fixture/skill-marketplace"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"

/** The catalog endpoint, counting how many times it was asked. */
const catalog = (options: { tools?: string; status?: number } = {}) => {
  const calls: { url: string }[] = []
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input) })
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    const headers = new Headers({ "content-type": "application/json" })
    headers.set("Mcp-Session-Id", "session-abc")
    const status = options.status ?? 200
    if (status !== 200) return new Response("upstream is unwell", { status })
    const method = String(body.method)
    if (method === "initialize")
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: {} }), { headers })
    if (method === "notifications/initialized") return new Response("", { status: 202, headers })
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: body.id,
        result: { content: [{ type: "text", text: options.tools ?? LISTING_A }] },
      }),
      { headers },
    )
  }) as unknown as typeof globalThis.fetch
  return { fetch, calls }
}

/** GitHub, answering one SKILL.md and counting the asks. */
const github = (body: string) => {
  const calls: string[] = []
  const fetch = (async (input: string | URL | Request) => {
    calls.push(String(input))
    return new Response(body, { status: 200 })
  }) as unknown as typeof globalThis.fetch
  return { fetch, calls }
}

const SKILL_BODY = "---\nname: react-patterns\ndescription: React 18/19 patterns\n---\n\nCompose well.\n"

/** The service bound to one project directory and one global config directory. */
const serviceFor = (
  project: string,
  config: string,
  transports: { catalog?: typeof globalThis.fetch; github?: typeof globalThis.fetch },
) => {
  const node = makeLocationNode({
    service: SkillMarketplace.Service,
    layer: SkillMarketplace.layerWith({ ...transports, upstream: { wait: false } }),
    deps: [Global.node, Location.node],
  })
  const deps = [
    Global.node.replace(Global.layerWith({ config, state: path.join(config, "state") })),
    Location.node.replace(
      Layer.succeed(
        Location.Service,
        Location.Service.of(location(Location.Ref.make({ directory: AbsolutePath.make(project) }))),
      ),
    ),
  ]
  return <A, E>(use: (service: SkillMarketplace.Interface) => Effect.Effect<A, E>) =>
    Effect.runPromise(
      Effect.gen(function* () {
        return yield* use(yield* SkillMarketplace.Service)
      }).pipe(Effect.provide(AppNodeBuilder.build(node, deps)), Effect.orDie),
    )
}

const cacheFile = (project: string) => path.join(project, SkillMarketplaceStore.DIRECTORY, "skills.jsonl")

describe("skill catalog in a project", () => {
  test("a query the cache cannot answer asks the catalog and caches what came back", async () => {
    await using tmp = await tmpdir()
    const project = path.join(tmp.path, "project")
    const upstream = catalog()
    const service = serviceFor(project, path.join(tmp.path, "config"), { catalog: upstream.fetch })

    const first = await service((catalog) => catalog.search({ query: "secret scanning" }))

    expect(first.cached).toBe(false)
    expect(first.hits.map((hit) => hit.skill.name)).toContain("openclaw-secret-scanning-maintainer")
    // The rows landed in this project's own directory, and can be read back from disk.
    const cached = await Bun.file(cacheFile(project)).text()
    expect(cached).toContain("openclaw-secret-scanning-maintainer")
    expect(await service((catalog) => catalog.stats)).toMatchObject({
      cached: first.hits.length > 0 ? expect.any(Number) : 0,
      degraded: false,
      directory: path.join(project, SkillMarketplaceStore.DIRECTORY),
    })
    expect((await service((catalog) => catalog.stats)).cached).toBeGreaterThan(0)
  })

  test("the same query again is answered from the cache without a request", async () => {
    await using tmp = await tmpdir()
    const project = path.join(tmp.path, "project")
    const upstream = catalog()
    const service = serviceFor(project, path.join(tmp.path, "config"), { catalog: upstream.fetch })
    await service((catalog) => catalog.search({ query: "secret scanning" }))
    const callsAfterFirst = upstream.calls.length

    const second = await service((catalog) => catalog.search({ query: "secret scanning" }))

    expect(second.cached).toBe(true)
    expect(second.hits[0]?.skill.name).toBe("openclaw-secret-scanning-maintainer")
    expect(upstream.calls).toHaveLength(callsAfterFirst)
  })

  test("two projects keep separate caches and each asks only for itself", async () => {
    await using tmp = await tmpdir()
    const first = path.join(tmp.path, "one")
    const second = path.join(tmp.path, "two")
    const config = path.join(tmp.path, "config")
    const upstream = catalog()
    const one = serviceFor(first, config, { catalog: upstream.fetch })
    const two = serviceFor(second, config, { catalog: upstream.fetch })

    await one((catalog) => catalog.search({ query: "secret scanning" }))

    expect((await one((catalog) => catalog.stats)).cached).toBeGreaterThan(0)
    // The second project knows nothing: it has its own file and has to ask for itself.
    expect((await two((catalog) => catalog.stats)).cached).toBe(0)
    const asked = await two((catalog) => catalog.search({ query: "secret scanning" }))
    expect(asked.cached).toBe(false)
    expect(await Bun.file(cacheFile(second)).exists()).toBe(true)
    expect(await Bun.file(cacheFile(first)).exists()).toBe(true)
  })

  test("a refusal leaves the project cache empty and says so", async () => {
    await using tmp = await tmpdir()
    const project = path.join(tmp.path, "project")
    const service = serviceFor(project, path.join(tmp.path, "config"), {
      catalog: catalog({ tools: QUOTA_REFUSAL }).fetch,
    })

    const failure = await service((catalog) => catalog.search({ query: "secret scanning" }).pipe(Effect.flip))

    expect(failure.message).toContain("quota")
    // Checked by reading the file: a refusal that left a row behind would look like a catalog row.
    expect(await Bun.file(cacheFile(project)).exists()).toBe(false)
    expect(await service((catalog) => catalog.stats)).toMatchObject({ cached: 0, degraded: false })
  })

  test("a non-200 leaves the project cache empty too", async () => {
    await using tmp = await tmpdir()
    const project = path.join(tmp.path, "project")
    const service = serviceFor(project, path.join(tmp.path, "config"), { catalog: catalog({ status: 503 }).fetch })

    const failure = await service((catalog) => catalog.search({ query: "secret scanning" }).pipe(Effect.flip))

    expect(failure.message).toContain("503")
    expect(await Bun.file(cacheFile(project)).exists()).toBe(false)
  })

  test("a damaged cache still answers, from the catalog, and repairs itself", async () => {
    await using tmp = await tmpdir()
    const project = path.join(tmp.path, "project")
    const upstream = catalog({ tools: LISTING_C })
    const service = serviceFor(project, path.join(tmp.path, "config"), { catalog: upstream.fetch })
    await Bun.write(cacheFile(project), '{"id":"half a row"')

    const answer = await service((catalog) => catalog.search({ query: "migrate to shoehorn" }))

    // The marker travels with the answer so the reader knows the cache was not trusted.
    expect(answer.damage).toContain("line 1")
    expect(answer.cached).toBe(false)
    expect((await service((catalog) => catalog.stats)).degraded).toBe(false)
    expect(await Bun.file(cacheFile(project)).text()).toContain("migrate-to-shoehorn")
  })

  test("reading a skill pulls its text from GitHub and leaves it in the project", async () => {
    await using tmp = await tmpdir()
    const project = path.join(tmp.path, "project")
    const config = path.join(tmp.path, "config")
    const upstream = catalog()
    const files = github(SKILL_BODY)
    const service = serviceFor(project, config, { catalog: upstream.fetch, github: files.fetch })
    await service((catalog) => catalog.search({ query: "react hooks" }))

    const read = await service((catalog) => catalog.read({ name: "react-patterns" }))

    // The skill path keeps the "/" the marketplace builds it with, whatever the platform joins with.
    const applied = `${path.join(project, ".opencode/skills")}/react-patterns/SKILL.md`
    // A fresh read comes from GitHub and says so; the copy it leaves is named separately.
    expect(read.source).toBe("https://raw.githubusercontent.com/affaan-m/ECC/main/.kiro/skills/react-patterns/SKILL.md")
    expect(read.applied).toBe(applied)
    expect(read.content).toBe(SKILL_BODY)
    expect(files.calls).toHaveLength(1)
    expect(await Bun.file(applied).text()).toBe(SKILL_BODY)

    // The second read is a file read: no second trip to GitHub.
    const again = await service((catalog) => catalog.read({ name: "react-patterns" }))
    expect(again.applied).toBeUndefined()
    expect(files.calls).toHaveLength(1)
  })

  test("a skill is kept for good only when saving is asked for", async () => {
    await using tmp = await tmpdir()
    const project = path.join(tmp.path, "project")
    const config = path.join(tmp.path, "config")
    const upstream = catalog()
    const files = github(SKILL_BODY)
    const service = serviceFor(project, config, { catalog: upstream.fetch, github: files.fetch })
    await service((catalog) => catalog.search({ query: "react hooks" }))
    await service((catalog) => catalog.read({ name: "react-patterns" }))

    // Searching and reading write into the project and nowhere else: a global skill follows the
    // user to every other project, which nothing about a search implies.
    expect(await Bun.file(path.join(config, "skills/react-patterns/SKILL.md")).exists()).toBe(false)

    const saved = await service((catalog) => catalog.save({ name: "react-patterns" }))

    expect(saved.path).toBe(`${path.join(config, "skills")}/react-patterns/SKILL.md`)
    expect(saved.existed).toBe(false)
    expect(await Bun.file(saved.path).text()).toBe(SKILL_BODY)
    // It reuses the copy already in the project rather than fetching the text again.
    expect(files.calls).toHaveLength(1)
  })

  test("a name the cache never saw is refused with a way out", async () => {
    await using tmp = await tmpdir()
    const service = serviceFor(path.join(tmp.path, "project"), path.join(tmp.path, "config"), {})

    const failure = await service((catalog) => catalog.read({ name: "not-a-skill" }).pipe(Effect.flip))

    expect(failure.message).toContain("Search first")
  })
})
