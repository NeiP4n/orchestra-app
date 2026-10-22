import { describe, expect, test } from "bun:test"
import { Duration, Effect } from "effect"
import { SkillMarketplaceRead } from "@orchestra/core/skill-marketplace/read"
import { SkillMarketplaceSave } from "@orchestra/core/skill-marketplace/save"
import { DECODED } from "./fixture/skill-marketplace"
import { tmpdir } from "./fixture/tmpdir"

// A real row from the cached catalog: its githubUrl points at a tree, so the branch is known.
const row = DECODED.find((skill) => skill.name === "openclaw-secret-scanning-maintainer")!
const GITHUB = row.githubUrl
const RAW =
  "https://raw.githubusercontent.com/openclaw/openclaw/main/.agents/skills/openclaw-secret-scanning-maintainer/SKILL.md"
const BODY = "---\nname: secret-scanning\ndescription: real\n---\n\nTriage alerts.\n"

const github = (body = BODY, status = 200) => {
  const asked: string[] = []
  const fetch = (async (input: string | URL | Request) => {
    asked.push(String(input))
    return new Response(body, { status })
  }) as unknown as typeof globalThis.fetch
  return { fetch, asked }
}

describe("skill text", () => {
  test("a tree URL becomes the raw link of the SKILL.md it points at", () => {
    expect(SkillMarketplaceRead.rawUrl(GITHUB)).toBe(RAW)
    // Not a GitHub link at all: there is nothing to derive, and saying so beats fetching a 404.
    expect(SkillMarketplaceRead.rawUrl(row.skillUrl)).toBeUndefined()
    expect(SkillMarketplaceRead.rawUrl("https://github.com/openclaw/openclaw")).toBeUndefined()
    expect(SkillMarketplaceRead.rawUrl("https://github.com/openclaw/openclaw/pull/42")).toBeUndefined()
  })

  test("a link that already names the file does not gain a second one", () => {
    expect(
      SkillMarketplaceRead.rawUrl("https://github.com/affaan-m/ECC/tree/main/skills/react-patterns/SKILL.md"),
    ).toBe("https://raw.githubusercontent.com/affaan-m/ECC/main/skills/react-patterns/SKILL.md")
  })

  test("the text comes from that one link, and nothing else is requested", async () => {
    const upstream = github()

    const text = await Effect.runPromise(SkillMarketplaceRead.read(GITHUB, { fetch: upstream.fetch }))

    expect(upstream.asked).toEqual([RAW])
    expect(text).toEqual({ url: RAW, content: BODY, truncated: false })
  })

  test("a long skill text is clipped at the documented ceiling", async () => {
    const upstream = github("x".repeat(SkillMarketplaceRead.MAX_CHARACTERS + 500))

    const text = await Effect.runPromise(SkillMarketplaceRead.read(GITHUB, { fetch: upstream.fetch }))

    expect(text.truncated).toBe(true)
    expect(text.content).toHaveLength(SkillMarketplaceRead.MAX_CHARACTERS)
  })

  test("a 404 from GitHub is a refusal with its status, not an empty skill", async () => {
    const upstream = github("Not Found", 404)

    const failure = await Effect.runPromise(
      SkillMarketplaceRead.read(GITHUB, { fetch: upstream.fetch }).pipe(Effect.flip),
    )

    expect(failure).toBeInstanceOf(SkillMarketplaceRead.ReadError)
    expect(failure.status).toBe(404)
  })

  test("a GitHub that never answers is a refusal, not a hanging tool", async () => {
    const fetch = (async () => await new Promise(() => {})) as unknown as typeof globalThis.fetch

    const failure = await Effect.runPromise(
      SkillMarketplaceRead.read(GITHUB, { fetch, timeout: Duration.millis(50) }).pipe(Effect.flip),
    )

    expect(failure.message).toContain("in time")
  })
})

describe("applying a skill into the project", () => {
  test("the text lands where the project's own loader looks for skills", async () => {
    await using tmp = await tmpdir()
    const root = `${tmp.path}/.opencode/skills`

    const written = await Effect.runPromise(SkillMarketplaceRead.apply(root, "react-patterns", BODY))

    expect(written).toBe(`${root}/react-patterns/SKILL.md`)
    expect(await Bun.file(written).text()).toBe(BODY)
    // The file must end with a newline: a skill file without one still parses, but every
    // hand-written SKILL.md in the catalog has one and the difference shows in diffs.
    expect(BODY.endsWith("\n")).toBe(true)
    expect(await Bun.file(`${root}/react-patterns/SKILL.md`).text()).toBe(BODY)
  })

  test("a catalog name that could climb out of the project is refused", async () => {
    await using tmp = await tmpdir()

    expect(SkillMarketplaceRead.appliedPath(tmp.path, "../../etc/passwd")).toBeUndefined()
    expect(SkillMarketplaceRead.appliedPath(tmp.path, "a/b")).toBeUndefined()
    expect(SkillMarketplaceRead.appliedPath(tmp.path, "")).toBeUndefined()
    const failure = await Effect.runPromise(SkillMarketplaceRead.apply(tmp.path, "../escape", BODY).pipe(Effect.flip))
    expect(failure.message).toContain("not a usable skill name")
  })
})

describe("keeping a skill for good", () => {
  test("nothing is written globally until save is asked for by name", async () => {
    await using tmp = await tmpdir()

    // Applying into a project says nothing about keeping a skill; only the global registry does.
    await Effect.runPromise(SkillMarketplaceRead.apply(`${tmp.path}/project/.opencode/skills`, "react-patterns", BODY))

    expect(await Bun.file(`${tmp.path}/config/skills/react-patterns/SKILL.md`).exists()).toBe(false)
  })

  test("save writes into the global skills directory and says where", async () => {
    await using tmp = await tmpdir()

    const result = await Effect.runPromise(SkillMarketplaceSave.save(`${tmp.path}/config/skills`, "react-patterns", BODY))

    expect(result.path).toBe(`${tmp.path}/config/skills/react-patterns/SKILL.md`)
    expect(result.existed).toBe(false)
    expect(await Bun.file(result.path).text()).toBe(BODY)
  })

  test("a skill already kept is left alone rather than rewritten", async () => {
    await using tmp = await tmpdir()
    await Effect.runPromise(SkillMarketplaceSave.save(`${tmp.path}/config/skills`, "react-patterns", BODY))

    const again = await Effect.runPromise(
      SkillMarketplaceSave.save(`${tmp.path}/config/skills`, "react-patterns", "a different body"),
    )

    expect(again.existed).toBe(true)
    expect(await Bun.file(again.path).text()).toBe(BODY)
  })

  test("a name that could climb out of the global registry is refused", async () => {
    await using tmp = await tmpdir()

    const failure = await Effect.runPromise(
      SkillMarketplaceSave.save(`${tmp.path}/config/skills`, "../escape", BODY).pipe(Effect.flip),
    )

    expect(failure).toBeInstanceOf(SkillMarketplaceSave.SaveError)
    expect(failure.message).toContain("not a usable skill name")
  })
})
