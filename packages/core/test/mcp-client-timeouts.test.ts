import { beforeEach, afterEach, describe, expect, test } from "bun:test"
import { executionTimeoutFor } from "../src/mcp/client"

// Limits apply by default (G2-3); only ORCHESTRA_DISABLE_LIMITS=1 (or the
// legacy ORCHESTRA_ENFORCE_LIMITS=0) lifts them, and then every timeout
// resolves to the 30-minute hard wall (see Limits.timeout).
const enforced = { ORCHESTRA_ENFORCE_LIMITS: "1" }
const unenforced = { ORCHESTRA_DISABLE_LIMITS: "1" }
import { SafetyConfig } from "../src/safety-config"
import { Limits } from "../src/limits"
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
let dir="",previous:string|undefined
beforeEach(()=>{previous=process.env.ORCHESTRA_STATE_DIR;dir=mkdtempSync(path.join(os.tmpdir(),"mcp-timeout-"));process.env.ORCHESTRA_STATE_DIR=dir})
afterEach(()=>{if(previous===undefined)delete process.env.ORCHESTRA_STATE_DIR;else process.env.ORCHESTRA_STATE_DIR=previous;rmSync(dir,{recursive:true,force:true})})

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

  test("30-minute wall remains unless the operator acknowledges full disable", () => {
    expect(executionTimeoutFor("serena", "initial_instructions", 60 * 60 * 1_000, enforced)).toBe(30 * 60 * 1_000)
    expect(executionTimeoutFor("context7", "resolve-library-id", undefined, unenforced)).toBe(5 * 60 * 1_000)
    SafetyConfig.write({version:1,disabled:true},"РАЗРЕШИТЬ")
    expect(executionTimeoutFor("context7", "resolve-library-id", undefined, unenforced)).toBe(Limits.UNBOUNDED_MS)
  })
})
