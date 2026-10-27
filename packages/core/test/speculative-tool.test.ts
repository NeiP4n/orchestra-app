import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import {
  canonicalJsonStringify,
  hashArgs,
  isReadOnlyTool,
  SpeculativeSecurityError,
  SpeculativeToolRunner,
} from "../src/tool/speculative"

describe("SpeculativeToolRunner Read-Only Engine", () => {
  test("classifies built-in read-only and mutating tools correctly", () => {
    // Read-only tools
    expect(isReadOnlyTool("read")).toBe(true)
    expect(isReadOnlyTool("glob")).toBe(true)
    expect(isReadOnlyTool("grep")).toBe(true)
    expect(isReadOnlyTool("webfetch")).toBe(true)
    expect(isReadOnlyTool("status")).toBe(true)
    expect(isReadOnlyTool("custom_inspect", { readOnlyHint: true })).toBe(true)
    expect(isReadOnlyTool("search_files")).toBe(true)

    // Mutating tools
    expect(isReadOnlyTool("write")).toBe(false)
    expect(isReadOnlyTool("edit")).toBe(false)
    expect(isReadOnlyTool("patch")).toBe(false)
    expect(isReadOnlyTool("shell")).toBe(false)
    expect(isReadOnlyTool("delete")).toBe(false)
    expect(isReadOnlyTool("rm")).toBe(false)
    expect(isReadOnlyTool("kill")).toBe(false)

    // Explicit override prevention for dangerous mutating tools
    expect(isReadOnlyTool("write", { readOnlyHint: true })).toBe(false)
    expect(isReadOnlyTool("shell", { readOnlyHint: true })).toBe(false)
  })

  test("rejects speculative execution of mutating tools with SpeculativeSecurityError", () => {
    const runner = new SpeculativeToolRunner()

    expect(() => {
      runner.speculate("ses_1", "write", { path: "test.txt", content: "data" }, async () => "ok")
    }).toThrow(SpeculativeSecurityError)

    expect(() => {
      runner.speculate("ses_1", "shell", { command: "rm -rf *" }, async () => "ok")
    }).toThrow(SpeculativeSecurityError)

    expect(() => {
      runner.speculate("ses_1", "edit", { path: "code.ts" }, async () => "ok")
    }).toThrow(SpeculativeSecurityError)
  })

  test("produces deterministic args hash regardless of object key order", () => {
    const args1 = { query: "Orchestra", limit: 10, offset: 0 }
    const args2 = { offset: 0, query: "Orchestra", limit: 10 }

    expect(canonicalJsonStringify(args1)).toBe(canonicalJsonStringify(args2))
    expect(hashArgs(args1)).toBe(hashArgs(args2))
  })

  test("executes read-only speculation and delivers instant cache hit upon commit", async () => {
    const runner = new SpeculativeToolRunner()
    const sessionId = "ses_spec_hit"
    const toolId = "read"
    const args = { path: "/workspace/config.json" }

    // Start background speculation
    const entry = runner.speculate(sessionId, toolId, args, async () => {
      await Bun.sleep(20)
      return { content: '{"status": "ok"}' }
    })

    expect(entry.status).toBe("pending")

    // Wait slightly for background completion
    await Bun.sleep(35)
    expect(entry.status).toBe("completed")

    // Commit should result in an instant cache hit
    const result = await runner.commit(sessionId, toolId, args)
    expect(result.hit).toBe(true)
    expect(result.status).toBe("completed")
    expect(result.value).toEqual({ content: '{"status": "ok"}' })
    expect(result.elapsedMs).toBeLessThan(10)

    const stats = runner.getStats()
    expect(stats.hits).toBe(1)
    expect(stats.speculations).toBe(1)
  })

  test("handles commit before background speculation completes by awaiting it", async () => {
    const runner = new SpeculativeToolRunner()
    const sessionId = "ses_spec_await"
    const toolId = "grep"
    const args = { pattern: "TODO" }

    runner.speculate(sessionId, toolId, args, async () => {
      await Bun.sleep(30)
      return ["Line 1: TODO"]
    })

    // Commit immediately while still pending
    const commitPromise = runner.commit(sessionId, toolId, args)
    const result = await commitPromise

    expect(result.hit).toBe(true)
    expect(result.status).toBe("completed")
    expect(result.value).toEqual(["Line 1: TODO"])
  })

  test("handles cache misses and runs fallback runners", async () => {
    const runner = new SpeculativeToolRunner()
    const sessionId = "ses_spec_miss"

    // Commit without speculation
    const missResult = await runner.commit(sessionId, "glob", { pattern: "*.ts" })
    expect(missResult.hit).toBe(false)
    expect(missResult.status).toBe("miss")

    // Commit with fallback runner
    const fallbackResult = await runner.commit(sessionId, "glob", { pattern: "*.ts" }, async () => {
      return ["file1.ts", "file2.ts"]
    })

    expect(fallbackResult.hit).toBe(false)
    expect(fallbackResult.status).toBe("completed")
    expect(fallbackResult.value).toEqual(["file1.ts", "file2.ts"])

    const stats = runner.getStats()
    expect(stats.misses).toBe(2)
  })

  test("discards pending speculations and aborts running execution", async () => {
    const runner = new SpeculativeToolRunner()
    const sessionId = "ses_to_discard"
    const otherSessionId = "ses_to_keep"

    let wasAborted = false
    runner.speculate(sessionId, "webfetch", { url: "https://example.com" }, async (signal) => {
      return new Promise((resolve) => {
        const timer = setTimeout(() => resolve("done"), 100)
        signal.addEventListener("abort", () => {
          clearTimeout(timer)
          wasAborted = true
        })
      })
    })

    // Another session's speculation
    let otherFinished = false
    runner.speculate(otherSessionId, "status", {}, async () => {
      await Bun.sleep(15)
      otherFinished = true
      return "healthy"
    })

    // Discard only the first session
    runner.discard(sessionId)
    expect(wasAborted).toBe(true)

    // Wait and verify other session continued intact
    await Bun.sleep(25)
    expect(otherFinished).toBe(true)

    const otherCommit = await runner.commit(otherSessionId, "status", {})
    expect(otherCommit.hit).toBe(true)
    expect(otherCommit.value).toBe("healthy")

    // First session commit is a miss because it was discarded
    const discardedCommit = await runner.commit(sessionId, "webfetch", { url: "https://example.com" })
    expect(discardedCommit.hit).toBe(false)
  })

  test("supports Effect-based speculative execution", async () => {
    const runner = new SpeculativeToolRunner()
    const sessionId = "ses_effect_spec"
    const toolId = "read"
    const args = { path: "/var/log/sys.log" }

    runner.speculate(sessionId, toolId, args, () =>
      Effect.gen(function* () {
        return yield* Effect.succeed({ lines: 42 })
      }),
    )

    await Bun.sleep(20)

    const result = await runner.commit(sessionId, toolId, args)
    expect(result.hit).toBe(true)
    expect(result.value).toEqual({ lines: 42 })
  })

  test("handles multiple concurrent speculations across distinct tools", async () => {
    const runner = new SpeculativeToolRunner()
    const sessionId = "ses_multi_spec"

    runner.speculate(sessionId, "read", { path: "A" }, async () => "Content A")
    runner.speculate(sessionId, "read", { path: "B" }, async () => "Content B")
    runner.speculate(sessionId, "glob", { pattern: "src/*" }, async () => ["src/index.ts"])

    await Bun.sleep(25)

    const [resA, resB, resGlob] = await Promise.all([
      runner.commit(sessionId, "read", { path: "A" }),
      runner.commit(sessionId, "read", { path: "B" }),
      runner.commit(sessionId, "glob", { pattern: "src/*" }),
    ])

    expect(resA.hit).toBe(true)
    expect(resA.value).toBe("Content A")

    expect(resB.hit).toBe(true)
    expect(resB.value).toBe("Content B")

    expect(resGlob.hit).toBe(true)
    expect(resGlob.value).toEqual(["src/index.ts"])
  })

  test("collects and updates speculative telemetry metrics (hits, misses, discards, savedMs)", async () => {
    const runner = new SpeculativeToolRunner()
    const sessionId = "ses_telemetry"

    // Initial stats should be zeroed
    const initialStats = runner.getStats()
    expect(initialStats.hits).toBe(0)
    expect(initialStats.misses).toBe(0)
    expect(initialStats.discards).toBe(0)
    expect(initialStats.savedMs).toBe(0)

    // 1. Speculate tool with ~30ms simulated work
    runner.speculate(sessionId, "read", { file: "a.ts" }, async () => {
      await Bun.sleep(30)
      return "content of a.ts"
    })

    // Wait until background speculation completes
    await Bun.sleep(45)

    // Commit should register a hit and calculate positive savedMs
    const commitHit = await runner.commit(sessionId, "read", { file: "a.ts" })
    expect(commitHit.hit).toBe(true)
    expect(commitHit.savedMs).toBeGreaterThan(0)

    let stats = runner.getStats()
    expect(stats.hits).toBe(1)
    expect(stats.misses).toBe(0)
    expect(stats.savedMs).toBeGreaterThan(0)

    // 2. Cache miss
    const commitMiss = await runner.commit(sessionId, "read", { file: "b.ts" })
    expect(commitMiss.hit).toBe(false)
    expect(commitMiss.status).toBe("miss")

    stats = runner.getStats()
    expect(stats.hits).toBe(1)
    expect(stats.misses).toBe(1)

    // 3. Discard pending speculation
    runner.speculate(sessionId, "grep", { pattern: "error" }, async () => {
      await Bun.sleep(100)
      return []
    })

    runner.discard(sessionId)
    stats = runner.getStats()
    expect(stats.discards).toBe(1)
    expect(stats.discarded).toBe(1)

    // 4. Clear runner
    runner.clear()
    const cleared = runner.getStats()
    expect(cleared.hits).toBe(0)
    expect(cleared.misses).toBe(0)
    expect(cleared.discards).toBe(0)
    expect(cleared.savedMs).toBe(0)
  })
})
