import { describe, expect, test } from "bun:test"
import { Option, Result, Schema } from "effect"
import { Skill, SkillMarketplace } from "../src/index.js"

/** `search:4fe30abeebf0244aff85ef439cf36997`, verbatim from cache.db. */
const INEXACT_LISTING = JSON.stringify({
  success: true,
  data: {
    skills: [
      {
        id: "openclaw-openclaw-agents-skills-test-audit-skill-md",
        name: "test-audit",
        author: "openclaw",
        description:
          "Invoke whenever writing, changing, reviewing, or sweeping tests. Authoring gate for new tests plus audit workflow for low-value, implementation-coupled, or duplicative tests and the test-only production seams they demand.",
        contentLanguage: "en",
        githubUrl: "https://github.com/openclaw/openclaw/tree/main/.agents/skills/test-audit",
        skillUrl: "https://skillsmp.com/creators/openclaw/openclaw/agents-skills-test-audit",
        stars: 389030,
        updatedAt: 1786787018,
      },
    ],
    pagination: { page: 1, limit: 1, total: 2, totalPages: 2, hasNext: true, hasPrev: false, totalIsExact: false },
    filters: { search: "test", sortBy: "stars" },
  },
  meta: { requestId: "611e81c2-5cee-49d1-ab0a-ae2b89e04ebe", responseTimeMs: 296 },
})

/** `search:2664beec66082aae13b58f729c8dd98b`, verbatim from cache.db. */
const TWO_ROWS_LISTING = JSON.stringify({
  success: true,
  data: {
    skills: [
      {
        id: "openclaw-openclaw-agents-skills-telegram-e2e-userbot-skill-md",
        name: "telegram-e2e-userbot",
        author: "openclaw",
        description:
          "Prove user-visible OpenClaw Telegram behavior on Telegram's Test Server with Convex-leased team credentials; drive real-user turns and record messages, edits, deletions, reactions, typing, or rich content.",
        contentLanguage: "en",
        githubUrl: "https://github.com/openclaw/openclaw/tree/main/.agents/skills/telegram-e2e-userbot",
        skillUrl: "https://skillsmp.com/creators/openclaw/openclaw/agents-skills-telegram-e2e-userbot",
        stars: 389030,
        updatedAt: 1788344328,
      },
      {
        id: "openclaw-openclaw-extensions-imessage-skills-imsg-skill-md",
        name: "imsg",
        author: "openclaw",
        description:
          "Use the imsg CLI from OpenClaw agents for iMessage/SMS DMs, groups, replies, reactions, polls, watching, and private-API actions.",
        contentLanguage: "en",
        githubUrl: "https://github.com/openclaw/openclaw/tree/main/extensions/imessage/skills/imsg",
        skillUrl: "https://skillsmp.com/creators/openclaw/openclaw/extensions-imessage-skills-imsg",
        stars: 389030,
        updatedAt: 1785803460,
      },
    ],
    pagination: { page: 1, limit: 2, total: 3, totalPages: 2, hasNext: true, hasPrev: false, totalIsExact: false },
    filters: { search: "react", sortBy: "stars" },
  },
  meta: { requestId: "b0b79acb-a692-46be-b959-4adfb0098508", responseTimeMs: 400 },
})

/** `search:0c6a647fb679275cd9539d48fb784576`, verbatim from cache.db. */
const EMPTY_LISTING = JSON.stringify({
  success: true,
  data: {
    skills: [],
    pagination: { page: 1, limit: 20, total: 0, totalPages: 1, hasNext: false, hasPrev: false, totalIsExact: true },
    filters: { search: "pdf", sortBy: "stars" },
  },
  meta: { requestId: "cbefaf79-f07e-40e7-85cb-488c3b687288", responseTimeMs: 276 },
})

/** Live `GET https://skillsmp.com/api/v1/skills/search` answered 429 with this body. */
const QUOTA_ERROR = JSON.stringify({
  success: false,
  error: {
    code: "DAILY_QUOTA_EXCEEDED",
    message:
      "Daily API quota of 50 requests exceeded. Resets at midnight UTC. Sign up and use an API key for a higher quota (500/day).",
  },
})

/** The refusal the retired MCP server documented; never observed from the catalog itself. */
const MISSING_QUERY_ERROR = JSON.stringify({
  success: false,
  error: { code: "MISSING_QUERY", message: "The q parameter is required." },
})

function listingOf(body: string) {
  const parsed = SkillMarketplace.parse(body)
  if (Result.isFailure(parsed)) throw new Error(`expected a listing, refused with ${parsed.failure.reason}`)
  if (SkillMarketplace.isError(parsed.success)) throw new Error("expected a listing, got an error")
  return parsed.success
}

describe("skill marketplace listing", () => {
  test("decodes a real cached listing into its structure", () => {
    const listing = listingOf(INEXACT_LISTING)
    expect(listing.success).toBe(true)
    expect(listing.data.skills).toHaveLength(1)
    expect(listing.data.skills[0].name).toBe("test-audit")
    expect(listing.data.skills[0].stars).toBe(389030)
    expect(listing.data.skills[0].contentLanguage).toBe("en")
    expect(listing.data.filters.search).toBe("test")
    expect(listing.data.filters.sortBy).toBe("stars")
    expect(listing.meta?.requestId).toBe("611e81c2-5cee-49d1-ab0a-ae2b89e04ebe")
    expect(listing.meta?.responseTimeMs).toBe(296)
  })

  test("carries every row of a multi-row listing", () => {
    const listing = listingOf(TWO_ROWS_LISTING)
    expect(listing.data.skills.map((skill) => skill.name)).toEqual(["telegram-e2e-userbot", "imsg"])
    expect(listing.data.pagination.provenRowCount).toBe(3)
  })

  test("names the row counter for what it counts", () => {
    // One row returned, the catalog claims two and says the count is inexact:
    // the counter is a proven lower bound, not the size of the catalog.
    const inexact = listingOf(INEXACT_LISTING).data.pagination
    expect(inexact.provenRowCount).toBe(2)
    expect(inexact.limit).toBe(1)
    expect(inexact.totalIsExact).toBe(false)
    expect(inexact.hasNext).toBe(true)

    const exact = listingOf(EMPTY_LISTING).data.pagination
    expect(exact.provenRowCount).toBe(0)
    expect(exact.totalIsExact).toBe(true)
    expect(exact.hasNext).toBe(false)
    expect(exact.provenPageCount).toBe(1)
  })

  test("has no field a developer could read as the catalog size", () => {
    const pagination = listingOf(INEXACT_LISTING).data.pagination as Record<string, unknown>
    expect(Object.keys(pagination).sort()).toEqual([
      "hasNext",
      "hasPrev",
      "limit",
      "page",
      "provenPageCount",
      "provenRowCount",
      "totalIsExact",
    ])
    expect(pagination).not.toHaveProperty("total")
    expect(pagination).not.toHaveProperty("totalPages")
    expect(pagination).not.toHaveProperty("count")
  })

  test("rejects a page the catalog would never return", () => {
    const decode = Schema.decodeUnknownOption(SkillMarketplace.Pagination)
    expect(Schema.is(SkillMarketplace.PageLimit)(50)).toBe(true)
    expect(Schema.is(SkillMarketplace.PageLimit)(51)).toBe(false)
    expect(Schema.is(SkillMarketplace.PageLimit)(0)).toBe(false)
    // One page past the ceiling must not decode, whatever else is right.
    expect(
      decode({
        page: 1,
        limit: 100,
        total: 2,
        totalPages: 2,
        hasNext: true,
        hasPrev: false,
        totalIsExact: false,
      }),
    ).toEqual(Option.none())
    // A page below one is not a page either.
    expect(
      decode({
        page: 0,
        limit: 20,
        total: 2,
        totalPages: 2,
        hasNext: true,
        hasPrev: false,
        totalIsExact: false,
      }),
    ).toEqual(Option.none())
  })
})

describe("skill marketplace refusals", () => {
  test("reads a refusal delivered with a successful HTTP status as an error", () => {
    for (const body of [QUOTA_ERROR, MISSING_QUERY_ERROR]) {
      const parsed = SkillMarketplace.parse(body)
      if (Result.isFailure(parsed)) throw new Error("expected a refusal, got a decode failure")
      expect(parsed.success.success).toBe(false)
      expect(SkillMarketplace.isError(parsed.success)).toBe(true)
      if (SkillMarketplace.isError(parsed.success)) expect(parsed.success.error.code).not.toBe("")
    }
    const parsed = SkillMarketplace.parse(QUOTA_ERROR)
    if (Result.isFailure(parsed)) throw new Error("expected a refusal, got a decode failure")
    if (!SkillMarketplace.isError(parsed.success)) throw new Error("expected a refusal")
    expect(parsed.success.error.code).toBe("DAILY_QUOTA_EXCEEDED")
  })

  test("never reports a refusal as an empty result set", () => {
    const parsed = SkillMarketplace.parse(QUOTA_ERROR)
    if (Result.isFailure(parsed)) throw new Error("expected a refusal, got a decode failure")
    // The whole point: an upstream refusal must not reach a caller as "no match".
    expect(SkillMarketplace.isError(parsed.success)).toBe(true)
    // A genuinely empty listing is a listing, and the two are told apart.
    const empty = SkillMarketplace.parse(EMPTY_LISTING)
    if (Result.isFailure(empty)) throw new Error("expected a listing, got a decode failure")
    expect(SkillMarketplace.isError(empty.success)).toBe(false)
    if (SkillMarketplace.isError(empty.success)) throw new Error("an empty listing is still a listing")
    expect(empty.success.data.skills).toHaveLength(0)
  })

  test("keeps an unknown refusal code instead of dropping the refusal", () => {
    const body = JSON.stringify({ success: false, error: { code: "SOME_FUTURE_CODE", message: "later" } })
    const parsed = SkillMarketplace.parse(body)
    if (Result.isFailure(parsed)) throw new Error("expected a refusal, got a decode failure")
    expect(SkillMarketplace.isError(parsed.success)).toBe(true)
    if (SkillMarketplace.isError(parsed.success)) expect(parsed.success.error.code).toBe("SOME_FUTURE_CODE")
  })

  test("refuses a refusal that does not say what went wrong", () => {
    // Without a code there is nothing to report and nothing to retry on, so the
    // body must be rejected rather than surfaced as a refusal with no reason.
    expect(
      Result.isFailure(SkillMarketplace.parse(JSON.stringify({ success: false, error: { message: "later" } }))),
    ).toBe(true)
    expect(Result.isFailure(SkillMarketplace.parse(JSON.stringify({ success: false, error: { code: "X" } })))).toBe(
      true,
    )
    expect(Result.isFailure(SkillMarketplace.parse(JSON.stringify({ success: false })))).toBe(true)
  })

  test("never reads a body that says it failed as a listing", () => {
    // A body carrying data under `success: false` is still a refusal. Letting it
    // through as a listing is how a failure turns into "no skills match".
    const data = JSON.parse(INEXACT_LISTING).data
    expect(Result.isFailure(SkillMarketplace.parse(JSON.stringify({ success: false, data })))).toBe(true)
  })
})

describe("skill marketplace unreadable bodies", () => {
  test("fails loudly instead of reporting zero skills", () => {
    for (const [body, reason] of [
      ["", "malformed_json"],
      ["not json at all", "malformed_json"],
      ['{"success":true,"data":', "malformed_json"],
      [JSON.stringify({ skills: [] }), "unexpected_shape"],
      [JSON.stringify({ success: true, data: {} }), "unexpected_shape"],
      [JSON.stringify({ success: true, data: { skills: [], pagination: {}, filters: {} } }), "unexpected_shape"],
      [JSON.stringify([]), "unexpected_shape"],
    ] as const) {
      const parsed = SkillMarketplace.parse(body)
      expect(Result.isFailure(parsed)).toBe(true)
      if (Result.isFailure(parsed)) {
        expect(parsed.failure.reason).toBe(reason)
        expect(parsed.failure.message.length).toBeGreaterThan(0)
      }
    }
  })

  test("rejects a listing whose pagination lies about its own shape", () => {
    const body = JSON.stringify({
      success: true,
      data: {
        skills: [],
        pagination: { page: 0, limit: 20, total: 0, totalPages: 1, hasNext: false, hasPrev: false, totalIsExact: true },
        filters: { search: "pdf", sortBy: "stars" },
      },
    })
    expect(Result.isFailure(SkillMarketplace.parse(body))).toBe(true)
  })

  test("refuses a listing that does not say how many rows it proved", () => {
    // The proven row count is the only thing telling a caller that more rows
    // exist, so a listing without it must not decode into a confident zero.
    const pagination = JSON.parse(EMPTY_LISTING).data.pagination
    const { total: _dropped, ...withoutCount } = pagination
    expect(
      Result.isFailure(
        SkillMarketplace.parse(
          JSON.stringify({ success: true, data: { skills: [], pagination: withoutCount, filters: {} } }),
        ),
      ),
    ).toBe(true)
    const { totalPages: _noPages, ...withoutPages } = pagination
    expect(
      Result.isFailure(
        SkillMarketplace.parse(
          JSON.stringify({ success: true, data: { skills: [], pagination: withoutPages, filters: {} } }),
        ),
      ),
    ).toBe(true)
  })

  test("accepts a listing whose language metadata is absent or null", () => {
    // The catalog documents contentLanguage as nullable and not required.
    const build = (skills: unknown[]) =>
      JSON.stringify({
        success: true,
        data: {
          skills,
          pagination: {
            page: 1,
            limit: 2,
            total: 2,
            totalPages: 1,
            hasNext: false,
            hasPrev: false,
            totalIsExact: true,
          },
          filters: { search: "pdf", sortBy: "stars" },
        },
      })
    const skill = { ...JSON.parse(TWO_ROWS_LISTING).data.skills[0] }
    const absent = listingOf(build([{ ...skill, contentLanguage: undefined }]))
    expect(absent.data.skills[0].contentLanguage).toBeUndefined()
    const nulled = listingOf(build([{ ...skill, contentLanguage: null }]))
    expect(nulled.data.skills[0].contentLanguage).toBeNull()
  })

  test("survives the hybrid pagination fields it does not model", () => {
    // The catalog documents countScope/nextCursor/isCapped/maxResults for hybrid
    // searches. They are unmodelled on purpose; an old client must not break on them.
    const body = JSON.stringify({
      success: true,
      data: {
        skills: [],
        pagination: {
          page: 1,
          limit: 20,
          total: 20,
          totalPages: 1,
          hasNext: false,
          hasPrev: false,
          totalIsExact: false,
          countScope: "candidates",
          nextCursor: "cursor-1",
          isCapped: true,
          maxResults: 20000,
        },
        filters: { search: "pdf", sortBy: "relevance" },
        search: { mode: "hybrid", searchId: "3f1b2c4d-0000-4000-8000-000000000000" },
        usage: { plan: "free", limit: 50, remaining: 49, resetAtMs: 1792022400000 },
      },
    })
    const listing = listingOf(body)
    expect(listing.data.pagination.provenRowCount).toBe(20)
    expect(listing.data.pagination).not.toHaveProperty("countScope")
    expect(listing.data).not.toHaveProperty("usage")
    expect(listing.data.filters.sortBy).toBe("relevance")
  })
})

describe("skill marketplace identifiers", () => {
  test("keeps public identifiers stable and unique", () => {
    const identifiers = [
      SkillMarketplace.ContentLanguage,
      SkillMarketplace.SortOrder,
      SkillMarketplace.Skill,
      SkillMarketplace.Pagination,
      SkillMarketplace.Filters,
      SkillMarketplace.Meta,
      SkillMarketplace.Data,
      SkillMarketplace.Listing,
      SkillMarketplace.Response,
      SkillMarketplace.DecodeFailure,
    ].map((schema) => schema.ast.annotations?.identifier)
    expect(identifiers.every((identifier) => typeof identifier === "string")).toBe(true)
    expect(new Set(identifiers).size).toBe(identifiers.length)
  })

  test("brands a catalog id so it cannot be passed where a local skill id belongs", () => {
    const slug = "openclaw-openclaw-agents-skills-test-audit-skill-md"
    expect(Schema.is(SkillMarketplace.SkillID)(slug)).toBe(true)
    const id = Schema.decodeUnknownSync(SkillMarketplace.SkillID)(slug)
    expect(String(id)).toBe(slug)
    // @ts-expect-error A catalog id is not the id of a skill installed on this machine.
    const local: Skill.ID = id
    expect(String(local)).toBe(slug)
  })

  test("types the proven counts as numbers a caller can rely on", () => {
    // The rename is a decode transform, so this pins the resulting Type too:
    // a count that could go missing must not reach a caller as `number | undefined`.
    const pagination = listingOf(EMPTY_LISTING).data.pagination
    const rows: number = pagination.provenRowCount
    const pages: number = pagination.provenPageCount
    const next: boolean = pagination.hasNext
    expect(rows).toBe(0)
    expect(pages).toBe(1)
    expect(next).toBe(false)
  })

  test("omits an absent language when encoding, so a round trip stays faithful", () => {
    const skill = JSON.parse(TWO_ROWS_LISTING).data.skills[0]
    const decoded = Schema.decodeUnknownSync(SkillMarketplace.Skill)({ ...skill, contentLanguage: null })
    expect(decoded.contentLanguage).toBeNull()
    expect(Schema.encodeSync(SkillMarketplace.Skill)(decoded)).toEqual({ ...skill, contentLanguage: null })

    // A skill the catalog sent without the key at all decodes to no value and
    // encodes back to no key, so a round trip does not invent language metadata.
    const { contentLanguage: _absent, ...withoutKey } = skill
    const decodedAbsent = Schema.decodeUnknownSync(SkillMarketplace.Skill)(withoutKey)
    expect(decodedAbsent.contentLanguage).toBeUndefined()
    expect(Schema.encodeSync(SkillMarketplace.Skill)(decodedAbsent)).not.toHaveProperty("contentLanguage")
  })
})
