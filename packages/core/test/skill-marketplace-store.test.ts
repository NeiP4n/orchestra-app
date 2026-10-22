import { describe, expect, test } from "bun:test"
import { readdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import { SkillMarketplaceStore } from "@orchestra/core/skill-marketplace/store"
import { DECODED } from "./fixture/skill-marketplace"
import { tmpdir } from "./fixture/tmpdir"

const rows = () => new Map(DECODED.map((skill) => [skill.id, skill] as const))
/** The service joins this relative directory onto the project directory; so does a test. */
const cacheIn = (project: string) => path.join(project, SkillMarketplaceStore.DIRECTORY)
const load = (directory: string) => Effect.runPromise(SkillMarketplaceStore.load(directory))
const meta = (directory: string) => Effect.runPromise(SkillMarketplaceStore.loadMeta(directory))
const save = (
  skills: ReadonlyMap<SkillMarketplaceStore.SkillID, SkillMarketplaceStore.Skill>,
  meta: SkillMarketplaceStore.Meta,
  directory: string,
) => Effect.runPromise(SkillMarketplaceStore.save(skills, meta, directory))

describe("skill catalog cache in the project", () => {
  test("the cache lives inside the project's own .opencode directory", async () => {
    await using tmp = await tmpdir()

    expect(SkillMarketplaceStore.DIRECTORY).toBe(".opencode/skill-catalog")
    expect(path.isAbsolute(SkillMarketplaceStore.DIRECTORY)).toBe(false)

    await save(rows(), { updatedAt: 1_784_000_000_000 }, cacheIn(tmp.path))

    // The rows travel with the project directory, so two projects never share what they saw.
    expect(await Bun.file(path.join(tmp.path, ".opencode/skill-catalog/skills.jsonl")).exists()).toBe(true)
    expect(await readdir(cacheIn(tmp.path))).toEqual(["meta.json", "skills.jsonl"])
  })

  test("rows survive a save and load unchanged", async () => {
    await using tmp = await tmpdir()
    const index = rows()

    await save(index, { updatedAt: 1_784_000_000_000 }, cacheIn(tmp.path))

    const loaded = await load(cacheIn(tmp.path))
    expect(loaded.degraded).toBe(false)
    expect(loaded.damage).toBeUndefined()
    expect(loaded.skills.size).toBe(index.size)
    // Field by field, not just by count: a row decoded into a different shape would otherwise
    // pass a size check while the search reads the wrong text.
    for (const [id, skill] of index) expect(loaded.skills.get(id)).toEqual(skill)
    expect(await meta(cacheIn(tmp.path))).toEqual({ updatedAt: 1_784_000_000_000 })
  })

  test("two projects keep separate caches", async () => {
    await using first = await tmpdir("project-one-")
    await using second = await tmpdir("project-two-")
    const subset = new Map([...rows()].slice(0, 3))

    await save(subset, { updatedAt: 1 }, cacheIn(first.path))

    expect((await load(cacheIn(first.path))).skills.size).toBe(3)
    // The second project has its own file and never sees the first project's rows.
    expect((await load(cacheIn(second.path))).skills.size).toBe(0)
    expect((await load(cacheIn(second.path))).degraded).toBe(false)
  })

  test("a project that never searched has an empty cache, not a damaged one", async () => {
    await using tmp = await tmpdir()

    const loaded = await load(cacheIn(tmp.path))

    expect(loaded.skills.size).toBe(0)
    expect(loaded.degraded).toBe(false)
    expect(loaded.damage).toBeUndefined()
    expect(await meta(cacheIn(tmp.path))).toEqual(SkillMarketplaceStore.emptyMeta)
  })

  test("a write that cannot land fails without emptying the previous cache", async () => {
    await using tmp = await tmpdir()
    await save(rows(), { updatedAt: 1 }, cacheIn(tmp.path))

    const failure = await Effect.runPromise(
      SkillMarketplaceStore.save(rows(), { updatedAt: 2 }, path.join(cacheIn(tmp.path), "skills.jsonl", "x")).pipe(
        Effect.flip,
      ),
    )

    expect(failure).toBeInstanceOf(SkillMarketplaceStore.StoreError)
    expect((await load(cacheIn(tmp.path))).skills.size).toBe(rows().size)
    // temp+rename: nothing half-written is left for the next reader to trip over.
    expect((await readdir(cacheIn(tmp.path))).filter((n) => n.endsWith(".tmp"))).toEqual([])
  })

  test("a damaged line costs the whole cache and names the line", async () => {
    await using tmp = await tmpdir()
    await save(rows(), { updatedAt: 1 }, cacheIn(tmp.path))
    const file = path.join(tmp.path, ".opencode/skill-catalog/skills.jsonl")
    const lines = (await readFile(file, "utf8")).trimEnd().split("\n")
    await writeFile(file, [lines[0], lines[1], '{"id":"half a row"', ...lines.slice(2)].join("\n"))

    const loaded = await load(cacheIn(tmp.path))

    // A subset would answer queries with a plausible-but-wrong catalog; an empty cache with a
    // marker tells the truth and the next search refills it.
    expect(loaded.skills.size).toBe(0)
    expect(loaded.degraded).toBe(true)
    expect(loaded.damage).toContain("line 3")
  })

  test("a line longer than the module writes is treated as damage, not memory pressure", async () => {
    await using tmp = await tmpdir()
    await save(rows(), { updatedAt: 1 }, cacheIn(tmp.path))
    await writeFile(
      path.join(tmp.path, ".opencode/skill-catalog/skills.jsonl"),
      JSON.stringify({ ...DECODED[0], description: "x".repeat(70_000) }),
    )

    const loaded = await load(cacheIn(tmp.path))

    expect(loaded.degraded).toBe(true)
    expect(loaded.skills.size).toBe(0)
    expect(loaded.damage).toContain("characters long")
  })

  test("damaged meta leaves the rows: it is provenance, not data", async () => {
    await using tmp = await tmpdir()
    await save(rows(), { updatedAt: 42 }, cacheIn(tmp.path))
    await writeFile(path.join(tmp.path, ".opencode/skill-catalog/meta.json"), "{ half a meta")

    expect((await load(cacheIn(tmp.path))).skills.size).toBe(rows().size)
    expect(await meta(cacheIn(tmp.path))).toEqual(SkillMarketplaceStore.emptyMeta)
  })
})
