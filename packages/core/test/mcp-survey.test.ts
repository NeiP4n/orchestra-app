import { describe, expect, test } from "bun:test"
import { McpSurvey } from "../src/mcp/survey"

const stamp = (at: number) => ({ "orchestra:mcp-survey": { at, configured: 2, catalog: 8 } })

describe("McpSurvey", () => {
  test("a fresh survey is fresh, a stale one is not, a missing one is not", () => {
    const now = Date.now()
    expect(McpSurvey.isFresh(stamp(now), now)).toBe(true)
    expect(McpSurvey.isFresh(stamp(now - McpSurvey.SURVEY_TTL_MS + 1000), now)).toBe(true)
    expect(McpSurvey.isFresh(stamp(now - McpSurvey.SURVEY_TTL_MS), now)).toBe(false)
    expect(McpSurvey.isFresh(stamp(now - 60 * 60 * 1000), now)).toBe(false)
    expect(McpSurvey.isFresh(undefined, now)).toBe(false)
    expect(McpSurvey.isFresh({}, now)).toBe(false)
    expect(McpSurvey.isFresh({ "orchestra:mcp-survey": { at: "yesterday" } }, now)).toBe(false)
    expect(McpSurvey.isFresh(stamp(now + 60_000), now)).toBe(false)
  })

  test("the TTL is fifteen minutes", () => {
    expect(McpSurvey.SURVEY_TTL_MS).toBe(15 * 60 * 1000)
  })
})
