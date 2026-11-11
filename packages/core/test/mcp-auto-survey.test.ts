import { expect, test } from "bun:test"
import { Effect } from "effect"
import { McpManagerTool } from "../src/tool/plugin/mcp-manager"
import { McpSurvey } from "../src/mcp/survey"

const full = "Configured server: status, tools, leases\nInstallable catalog\nNative methods\nRatings"
const stamp = (at: number) => ({ [McpSurvey.SURVEY_METADATA_KEY]: { at, configured: 1, catalog: 8 } })

test("successful inspect is shown in full and cached only within the TTL", async () => {
  let calls = 0
  const survey = McpManagerTool.autoSurvey()
  const input = { sessionID: "main", metadata: stamp(100), now: 100, inspect: Effect.sync(() => { calls++; return full }), invalidate: Effect.die("must not invalidate") }
  expect(await Effect.runPromise(survey(input))).toBe(full)
  expect(await Effect.runPromise(survey({ ...input, now: 101 }))).toBe(full)
  expect(calls).toBe(1)
  expect(await Effect.runPromise(survey({ ...input, now: 100 + McpSurvey.SURVEY_TTL_MS }))).toBe(full)
  expect(calls).toBe(2)
})

test("failed inspect returns no survey and invalidates a pre-existing stamp", async () => {
  let metadata: Record<string, unknown> | undefined = stamp(100)
  const survey = McpManagerTool.autoSurvey()
  const result = await Effect.runPromise(survey({ sessionID: "main", metadata, now: 101,
    inspect: Effect.fail(new Error("inspect unavailable")), invalidate: Effect.sync(() => { metadata = undefined }) }))
  expect(result).toBeUndefined()
  expect(McpSurvey.isFresh(metadata, 101)).toBe(false)
})

test("expired successful cache cannot hide an inspect failure", async () => {
  let invalidated = false
  const survey = McpManagerTool.autoSurvey()
  const input = { sessionID: "main", metadata: stamp(100), now: 100, inspect: Effect.succeed(full), invalidate: Effect.sync(() => { invalidated = true }) }
  expect(await Effect.runPromise(survey(input))).toBe(full)
  expect(await Effect.runPromise(survey({ ...input, now: 100 + McpSurvey.SURVEY_TTL_MS, inspect: Effect.fail(new Error("offline")) }))).toBeUndefined()
  expect(invalidated).toBe(true)
})
