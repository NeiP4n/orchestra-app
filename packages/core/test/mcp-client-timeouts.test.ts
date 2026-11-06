import { describe, expect, test } from "bun:test"
import { executionTimeoutFor } from "../src/mcp/client"

// Limits only apply while ORCHESTRA_ENFORCE_LIMITS=1; without it every
// timeout resolves to the 30-minute hard wall (see Limits.timeout).
const enforced = { ORCHESTRA_ENFORCE_LIMITS: "1" }
const unenforced = { ORCHESTRA_ENFORCE_LIMITS: "0" }

describe("executionTimeoutFor", () => {
  test("defaults to 5 minutes for an ordinary tool", () => {
    expect(executionTimeoutFor("context7", "resolve-library-id", undefined, enforced)).toBe(5 * 60 * 1_000)
    expect(executionTimeoutFor("playwright", "browser_navigate", undefined, enforced)).toBe(5 * 60 * 1_000)
    expect(executionTimeoutFor("context7", undefined, undefined, enforced)).toBe(5 * 60 * 1_000)
  })

  test("known-slow tools get 10 minutes from the per-tool table", () => {
    expect(executionTimeoutFor("serena", "initial_instructions", undefined, enforced)).toBe(10 * 60 * 1_000)
    expect(executionTimeoutFor("serena", "serena_repl", undefined, enforced)).toBe(10 * 60 * 1_000)
    expect(executionTimeoutFor("deepwiki", "ask_question", undefined, enforced)).toBe(10 * 60 * 1_000)
    // The table is keyed by server and tool together: the same tool name
    // on another server, and another tool on the same server, stay default.
    expect(executionTimeoutFor("context7", "ask_question", undefined, enforced)).toBe(5 * 60 * 1_000)
    expect(executionTimeoutFor("deepwiki", "read_wiki_structure", undefined, enforced)).toBe(5 * 60 * 1_000)
  })

  test("explicit per-server config wins over the table", () => {
    expect(executionTimeoutFor("serena", "initial_instructions", 60_000, enforced)).toBe(60_000)
    expect(executionTimeoutFor("context7", "resolve-library-id", 60_000, enforced)).toBe(60_000)
  })

  test("no call runs without a timeout: everything clamps to the 30-minute wall", () => {
    expect(executionTimeoutFor("serena", "initial_instructions", 60 * 60 * 1_000, enforced)).toBe(30 * 60 * 1_000)
    expect(executionTimeoutFor("context7", "resolve-library-id", undefined, unenforced)).toBe(30 * 60 * 1_000)
  })
})
