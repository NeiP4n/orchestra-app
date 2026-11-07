import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { SessionRequestMeasurement } from "@orchestra/core/session/request-measurement"

const begun = SessionRequestMeasurement.begin(SessionRequestMeasurement.empty, {
  measurementID: "m-1",
  sessionID: "ses-1",
  logicalRequestID: "lr-1",
  attemptID: "a-1",
  phase: "primary",
  providerID: "zen",
  modelID: "glm-4.6",
  startedAt: 1000,
  toolCount: 3,
  messageCount: 12,
})

describe("SessionRequestMeasurement.begin", () => {
  test("opens an attempt with unknowns as null, never as zero", () => {
    const attempt = SessionRequestMeasurement.attempt(begun, "a-1")
    expect(attempt?.outcome).toBe("unknown")
    expect(attempt?.endedAt).toBeNull()
    expect(attempt?.durationMs).toBeNull()
    expect(attempt?.retryOf).toBeNull()
    expect(attempt?.usage).toEqual({ input: null, output: null, reasoning: null, cacheRead: null, cacheWrite: null })
    expect(attempt?.cost).toEqual({ recordedUSD: null, estimatedUSD: null, source: "unknown" })
    expect(attempt?.goalID).toBeNull()
    expect(attempt?.taskID).toBeNull()
    expect(attempt?.role).toBeNull()
    expect(attempt?.attribution).toBe("unknown")
    expect(attempt?.sdkRetries).toBe("uncounted")
  })

  test("a retry keeps the logical request and names the attempt it retries", () => {
    const ledger = SessionRequestMeasurement.begin(begun, {
      measurementID: "m-2",
      sessionID: "ses-1",
      logicalRequestID: "lr-1",
      attemptID: "a-2",
      retryOf: "a-1",
      phase: "primary",
      providerID: "zen",
      modelID: "glm-4.6",
      startedAt: 2000,
      toolCount: 3,
      messageCount: 12,
    })
    const retry = SessionRequestMeasurement.attempt(ledger, "a-2")
    expect(retry?.logicalRequestID).toBe("lr-1")
    expect(retry?.attemptID).toBe("a-2")
    expect(retry?.retryOf).toBe("a-1")
    expect(SessionRequestMeasurement.attempt(ledger, "a-1")?.outcome).toBe("unknown")
  })
})

describe("SessionRequestMeasurement.finish", () => {
  const done = SessionRequestMeasurement.finish(begun, "a-1", {
    outcome: "completed",
    endedAt: 1600,
    usage: { input: 100, output: 40, reasoning: 0, cacheRead: 10, cacheWrite: 5 },
    cost: { recordedUSD: 0.0002, estimatedUSD: null, source: "provider" },
  })

  test("records the terminal state and computes the duration", () => {
    const attempt = SessionRequestMeasurement.attempt(done, "a-1")
    expect(attempt?.outcome).toBe("completed")
    expect(attempt?.endedAt).toBe(1600)
    expect(attempt?.durationMs).toBe(600)
    expect(attempt?.usage.input).toBe(100)
    expect(attempt?.usage.cacheRead).toBe(10)
    expect(attempt?.cost.recordedUSD).toBe(0.0002)
    expect(attempt?.cost.estimatedUSD).toBeNull()
  })

  test("a duplicate terminal event does not create a second record or change the first", () => {
    const twice = SessionRequestMeasurement.finish(done, "a-1", {
      outcome: "failed",
      endedAt: 9999,
      usage: { input: 999, output: 999, reasoning: 999, cacheRead: 999, cacheWrite: 999 },
      cost: { recordedUSD: 42, estimatedUSD: null, source: "provider" },
    })
    expect(twice).toBe(done)
    const attempt = SessionRequestMeasurement.attempt(twice, "a-1")
    expect(attempt?.outcome).toBe("completed")
    expect(attempt?.usage.input).toBe(100)
  })

  test("two parallel attempts never mix their terminal state", () => {
    const both = SessionRequestMeasurement.begin(begun, {
      measurementID: "m-2",
      sessionID: "ses-1",
      logicalRequestID: "lr-2",
      attemptID: "a-2",
      phase: "primary",
      providerID: "zen",
      modelID: "glm-4.6",
      startedAt: 1100,
      toolCount: 3,
      messageCount: 12,
    })
    const finished = SessionRequestMeasurement.finish(both, "a-2", {
      outcome: "failed",
      endedAt: 1500,
      usage: { input: 7, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      cost: { recordedUSD: null, estimatedUSD: null, source: "unknown" },
    })
    expect(SessionRequestMeasurement.attempt(finished, "a-1")?.outcome).toBe("unknown")
    expect(SessionRequestMeasurement.attempt(finished, "a-2")?.outcome).toBe("failed")
    expect(SessionRequestMeasurement.attempt(finished, "a-2")?.durationMs).toBe(400)
  })

  test("finishing an unknown attempt leaves the ledger untouched", () => {
    expect(SessionRequestMeasurement.finish(begun, "a-zzz", { outcome: "completed", endedAt: 1 })).toBe(begun)
  })
})

describe("SessionRequestMeasurement.toLine", () => {
  test("serializes deterministically: the same attempt gives the same string", () => {
    const done = SessionRequestMeasurement.finish(begun, "a-1", { outcome: "completed", endedAt: 1600 })
    const attempt = SessionRequestMeasurement.attempt(done, "a-1")!
    expect(SessionRequestMeasurement.toLine(attempt)).toBe(SessionRequestMeasurement.toLine(attempt))
    expect(SessionRequestMeasurement.toLine(attempt)).toBe(
      JSON.stringify(JSON.parse(SessionRequestMeasurement.toLine(attempt))),
    )
  })

  test("keeps null distinct from zero", () => {
    const done = SessionRequestMeasurement.finish(begun, "a-1", {
      outcome: "completed",
      endedAt: 1600,
      usage: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    })
    const parsed = JSON.parse(SessionRequestMeasurement.toLine(SessionRequestMeasurement.attempt(done, "a-1")!))
    expect(parsed.usage.input).toBe(0)
    expect(parsed.cost.recordedUSD).toBeNull()
    expect(parsed.endedAt).toBe(1600)
    const open = JSON.parse(SessionRequestMeasurement.toLine(SessionRequestMeasurement.attempt(begun, "a-1")!))
    expect(open.usage.input).toBeNull()
    expect(open.endedAt).toBeNull()
  })

  test("stray fields, secrets and text never reach the serialized line", () => {
    const canary = "sk-canarySECRET0123456789"
    const dirty = SessionRequestMeasurement.begin(SessionRequestMeasurement.empty, {
      measurementID: "m-9",
      sessionID: "ses-1",
      logicalRequestID: "lr-9",
      attemptID: "a-9",
      phase: "primary",
      providerID: "zen",
      modelID: "glm-4.6",
      startedAt: 1000,
      toolCount: 1,
      messageCount: 1,
      // Fields the contract does not have: a caller mistake must not leak.
      ...({ apiKey: canary, prompt: "show me the password", headers: { authorization: `Bearer ${canary}` } } as object),
    })
    const line = SessionRequestMeasurement.toLine(SessionRequestMeasurement.attempt(dirty, "a-9")!)
    expect(line).not.toContain(canary)
    expect(line).not.toContain("password")
    expect(line).not.toContain("prompt")
    expect(line).not.toContain("apiKey")
    expect(line).not.toContain("headers")
  })

  test("carries assignment attribution only when it is given, never derived", () => {
    const withAssignment = SessionRequestMeasurement.begin(SessionRequestMeasurement.empty, {
      measurementID: "m-3",
      sessionID: "ses-1",
      logicalRequestID: "lr-3",
      attemptID: "a-3",
      phase: "primary",
      providerID: "zen",
      modelID: "glm-4.6",
      startedAt: 1000,
      toolCount: 0,
      messageCount: 5,
      assignment: { goalID: "g-1", taskID: "t-1", role: "developer" },
    })
    const attempt = SessionRequestMeasurement.attempt(withAssignment, "a-3")!
    expect(attempt.attribution).toBe("assignment")
    expect(attempt.goalID).toBe("g-1")
    expect(attempt.role).toBe("developer")
    const parsed = JSON.parse(SessionRequestMeasurement.toLine(attempt))
    expect(parsed.goalID).toBe("g-1")
    expect(parsed.attribution).toBe("assignment")
  })
})

describe("SessionRequestMeasurement opt-in collection", () => {
  const mkdtemp = () => fs.mkdtempSync(path.join(os.tmpdir(), "measure-"))
  const request = {
    model: { provider: "zen", id: "glm-4.6" },
    system: [{ text: "You are helpful." }],
    tools: [{ name: "bash", description: "Run commands", inputSchema: { type: "object" } }],
    messages: [{ role: "user", content: "Fix the bug" }],
  }

  test("the flag is off by default and never enables the old report", () => {
    delete process.env.ORCHESTRA_REQUEST_MEASUREMENT
    delete process.env.ORCHESTRA_REQUEST_REPORT
    expect(SessionRequestMeasurement.enabled()).toBe(false)
    process.env.ORCHESTRA_REQUEST_MEASUREMENT = "1"
    expect(SessionRequestMeasurement.enabled()).toBe(true)
    expect(process.env.ORCHESTRA_REQUEST_REPORT).toBeUndefined()
    delete process.env.ORCHESTRA_REQUEST_MEASUREMENT
  })

  test("measuring leaves the request byte-identical", () => {
    const frozen = Object.freeze({
      ...request,
      model: Object.freeze(request.model),
      system: Object.freeze(request.system.map((part) => Object.freeze(part))),
      tools: Object.freeze(request.tools.map((tool) => Object.freeze(tool))),
      messages: Object.freeze(request.messages.map((message) => Object.freeze(message))),
    })
    const before = JSON.stringify(frozen)
    SessionRequestMeasurement.sizesOf(frozen)
    expect(JSON.stringify(frozen)).toBe(before)
  })

  test("sizesOf counts without keeping the text", () => {
    const sizes = SessionRequestMeasurement.sizesOf(request)
    expect(sizes.providerID).toBe("zen")
    expect(sizes.toolCount).toBe(1)
    expect(sizes.messageCount).toBe(1)
    expect(sizes.estimates.method).toBe("chars/3.5")
    expect(sizes.estimates.system).toBeGreaterThan(0)
    expect(sizes.estimates.tools).toBeGreaterThan(0)
    expect(sizes.estimates.history).toBeGreaterThan(0)
  })

  test("a disk error is swallowed and changes nothing", async () => {
    await Effect.runPromise(SessionRequestMeasurement.writeLine("{}", path.join(os.tmpdir(), "no-such-dir-\u0000bad")))
  })

  test("concurrent writes keep every line", async () => {
    const dir = mkdtemp()
    await Effect.runPromise(
      Effect.all(
        [SessionRequestMeasurement.writeLine('{"a":1}', dir), SessionRequestMeasurement.writeLine('{"b":2}', dir)],
        {
          concurrency: "unbounded",
        },
      ),
    )
    const lines = fs
      .readdirSync(dir)
      .flatMap((file) => fs.readFileSync(path.join(dir, file), "utf8").trim().split("\n"))
    expect(lines.toSorted()).toEqual(['{"a":1}', '{"b":2}'])
  })

  test("retention removes old measurements but never foreign files", async () => {
    const dir = mkdtemp()
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    const ours = path.join(dir, "0e1c4b32-0000-4000-8000-000000000000.jsonl")
    const foreign = path.join(dir, "keepme.json")
    const foreignJsonl = path.join(dir, "UPPERCASE.JSONL")
    fs.writeFileSync(ours, "{}\n")
    fs.writeFileSync(foreign, "do not touch")
    fs.writeFileSync(foreignJsonl, "{}\n")
    fs.utimesSync(ours, old, old)
    fs.utimesSync(foreign, old, old)
    fs.utimesSync(foreignJsonl, old, old)
    await SessionRequestMeasurement.pruneOldMeasurements(dir)
    expect(fs.existsSync(ours)).toBe(false)
    expect(fs.readFileSync(foreign, "utf8")).toBe("do not touch")
    expect(fs.existsSync(foreignJsonl)).toBe(true)
  })

  test("retention sweep is bounded: at most the limit is examined per call", async () => {
    const dir = mkdtemp()
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    for (let i = 0; i < 5; i++) {
      const file = path.join(dir, `0e1c4b32-0000-4000-8000-00000000000${i}.jsonl`)
      fs.writeFileSync(file, "{}\n")
      fs.utimesSync(file, old, old)
    }
    const removed = await SessionRequestMeasurement.pruneOldMeasurements(dir, Date.now(), 3)
    expect(removed).toBe(3)
    expect(fs.readdirSync(dir).length).toBe(2)
    expect(await SessionRequestMeasurement.pruneOldMeasurements(dir, Date.now(), 3)).toBe(2)
    expect(fs.readdirSync(dir).length).toBe(0)
  })

  test("write path sweeps infrequently: a second write inside the interval does not rescan", async () => {
    SessionRequestMeasurement.resetSweepThrottleForTests()
    const dir = mkdtemp()
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    const first = path.join(dir, "0e1c4b32-0000-4000-8000-0000000000aa.jsonl")
    fs.writeFileSync(first, "{}\n")
    fs.utimesSync(first, old, old)
    const t0 = Date.now()
    expect(await SessionRequestMeasurement.maybeSweep(dir, t0)).toBe(1)
    expect(fs.existsSync(first)).toBe(false)

    const second = path.join(dir, "0e1c4b32-0000-4000-8000-0000000000bb.jsonl")
    fs.writeFileSync(second, "{}\n")
    fs.utimesSync(second, old, old)
    expect(await SessionRequestMeasurement.maybeSweep(dir, t0 + 1000)).toBe(0)
    expect(fs.existsSync(second)).toBe(true)

    expect(await SessionRequestMeasurement.maybeSweep(dir, t0 + SessionRequestMeasurement.SWEEP_INTERVAL_MS + 1)).toBe(
      1,
    )
    expect(fs.existsSync(second)).toBe(false)
    SessionRequestMeasurement.resetSweepThrottleForTests()
  })

  test("concurrent sweeps serialize onto one in-flight scan", async () => {
    SessionRequestMeasurement.resetSweepThrottleForTests()
    const dir = mkdtemp()
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    const file = path.join(dir, "0e1c4b32-0000-4000-8000-0000000000cc.jsonl")
    fs.writeFileSync(file, "{}\n")
    fs.utimesSync(file, old, old)
    const t0 = Date.now()
    const [a, b] = await Promise.all([
      SessionRequestMeasurement.maybeSweep(dir, t0),
      SessionRequestMeasurement.maybeSweep(dir, t0),
    ])
    expect(a + b).toBe(1)
    expect(fs.existsSync(file)).toBe(false)
    SessionRequestMeasurement.resetSweepThrottleForTests()
  })

  test("canary secrets from the prompt never reach the saved bytes", async () => {
    const canary = "sk-canarySECRET0123456789"
    const dirty = {
      model: { provider: "zen", id: "glm-4.6" },
      system: [{ text: `The key is ${canary}` }],
      tools: [{ name: "bash", description: `uses ${canary} in examples` }],
      messages: [{ role: "user", content: `Authorization: Bearer ${canary}` }],
    }
    const sizes = SessionRequestMeasurement.sizesOf(dirty)
    const dir = mkdtemp()
    await Effect.runPromise(
      SessionRequestMeasurement.writeLine(
        SessionRequestMeasurement.sizesLine(
          SessionRequestMeasurement.open({
            measurementID: "m-1",
            sessionID: "ses-1",
            logicalRequestID: "lr-1",
            attemptID: "a-1",
            phase: "primary",
            providerID: sizes.providerID,
            modelID: sizes.modelID,
            startedAt: 1000,
            toolCount: sizes.toolCount,
            messageCount: sizes.messageCount,
            estimates: sizes.estimates,
          }),
        ),
        dir,
      ),
    )
    const saved = fs
      .readdirSync(dir)
      .map((file) => fs.readFileSync(path.join(dir, file), "utf8"))
      .join("")
    expect(saved).not.toContain(canary)
    expect(saved).not.toContain("Authorization")
    const parsed = JSON.parse(saved.trim())
    expect(parsed.coverage).toBe("primary-sizes")
    expect(parsed.record.estimates.system).toBeGreaterThan(0)
    const mode = fs.statSync(path.join(dir, fs.readdirSync(dir)[0])).mode & 0o777
    expect(mode).toBe(0o600)
  })
})

describe("SessionRequestMeasurement contract invariants", () => {
  test("begin never overwrites an existing attempt, terminal or open", () => {
    const done = SessionRequestMeasurement.finish(begun, "a-1", { outcome: "completed", endedAt: 1600 })
    const again = SessionRequestMeasurement.begin(done, {
      measurementID: "m-x",
      sessionID: "ses-1",
      logicalRequestID: "lr-x",
      attemptID: "a-1",
      phase: "title",
      providerID: "other",
      modelID: "other",
      startedAt: 5000,
      toolCount: 0,
      messageCount: 0,
    })
    expect(again).toBe(done)
    expect(SessionRequestMeasurement.attempt(again, "a-1")?.outcome).toBe("completed")
  })

  test("prose-like IDs and invalid enums are rejected", () => {
    const base = {
      measurementID: "m-1",
      sessionID: "ses-1",
      logicalRequestID: "lr-1",
      attemptID: "a-1",
      providerID: "zen",
      modelID: "glm-4.6",
      startedAt: 1000,
      toolCount: 0,
      messageCount: 0,
    }
    expect(() =>
      SessionRequestMeasurement.open({ ...base, phase: "primary", sessionID: "Fix the login bug now" }),
    ).toThrow()
    expect(() => SessionRequestMeasurement.open({ ...base, phase: "tell me a story" as never })).toThrow()
    expect(() => SessionRequestMeasurement.open({ ...base, phase: "primary", providerID: "" })).toThrow()
    expect(() => SessionRequestMeasurement.open({ ...base, phase: "primary", modelID: 'say "hi"' })).toThrow()
  })

  test("NaN and negative numbers are rejected", () => {
    const base = {
      measurementID: "m-1",
      sessionID: "ses-1",
      logicalRequestID: "lr-1",
      attemptID: "a-1",
      providerID: "zen",
      modelID: "glm-4.6",
      toolCount: 0,
      messageCount: 0,
    }
    expect(() => SessionRequestMeasurement.open({ ...base, phase: "primary", startedAt: Number.NaN })).toThrow()
    expect(() => SessionRequestMeasurement.open({ ...base, phase: "primary", startedAt: -5 })).toThrow()
    expect(() =>
      SessionRequestMeasurement.finish(begun, "a-1", {
        outcome: "completed",
        endedAt: 1600,
        usage: { input: -1, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      }),
    ).toThrow()
    expect(() =>
      SessionRequestMeasurement.finish(begun, "a-1", {
        outcome: "completed",
        endedAt: 1600,
        cost: { recordedUSD: Number.NaN, estimatedUSD: null, source: "provider" },
      }),
    ).toThrow()
  })
})

describe("SessionRequestMeasurement lifecycle and export", () => {
  const mkdtemp = () => fs.mkdtempSync(path.join(os.tmpdir(), "measure-"))
  const request = {
    model: { provider: "zen", id: "glm-4.6" },
    system: [{ text: "You are helpful." }],
    tools: [{ name: "bash", description: "Run commands" }],
    messages: [{ role: "user", content: "Fix the bug" }],
  }
  const withFlag = async (run: () => Promise<void>) => {
    process.env.ORCHESTRA_REQUEST_MEASUREMENT = "1"
    try {
      await run()
    } finally {
      delete process.env.ORCHESTRA_REQUEST_MEASUREMENT
      SessionRequestMeasurement.untrackAll()
    }
  }

  test("disabled means no filesystem effects and nothing tracked", async () => {
    const dir = mkdtemp()
    await Effect.runPromise(SessionRequestMeasurement.recordPrimarySizes({ sessionID: "ses-1", request }, dir))
    expect(fs.readdirSync(dir)).toEqual([])
    expect(SessionRequestMeasurement.pendingAttempt("ses-1")).toBeUndefined()
  })

  test("a line over the size cap is dropped, not truncated", async () => {
    const dir = mkdtemp()
    await Effect.runPromise(
      SessionRequestMeasurement.writeLine("x".repeat(SessionRequestMeasurement.MAX_LINE_BYTES + 1), dir),
    )
    expect(fs.readdirSync(dir)).toEqual([])
  })

  test("writeLine creates a missing directory tree with private permissions", async () => {
    const dir = path.join(mkdtemp(), "nested", "deeper")
    await Effect.runPromise(SessionRequestMeasurement.writeLine("{}", dir))
    expect(fs.readdirSync(dir)).toHaveLength(1)
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700)
    expect(fs.statSync(path.join(dir, fs.readdirSync(dir)[0])).mode & 0o777).toBe(0o600)
  })

  test("a throwing extraction cannot fail the caller", async () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    const dir = mkdtemp()
    await withFlag(async () => {
      await Effect.runPromise(
        SessionRequestMeasurement.recordPrimarySizes(
          { sessionID: "ses-1", request: { ...request, messages: [{ content: circular }] } },
          dir,
        ),
      )
    })
    expect(fs.readdirSync(dir)).toEqual([])
    expect(SessionRequestMeasurement.pendingAttempt("ses-1")).toBeUndefined()
  })

  test("completePrimary finalizes once; a duplicate is a no-op", async () => {
    const dir = mkdtemp()
    await withFlag(async () => {
      const first = await Effect.runPromise(
        SessionRequestMeasurement.recordPrimarySizes({ sessionID: "ses-1", request }, dir),
      )
      expect(first).toBeDefined()
      await Effect.runPromise(
        SessionRequestMeasurement.completePrimary(
          "ses-1",
          {
            outcome: "completed",
            endedAt: Date.now(),
            usage: { input: 10, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
            cost: { recordedUSD: null, estimatedUSD: 0.0001, source: "catalog" },
          },
          { attemptID: first!.attemptID, directory: dir },
        ),
      )
      await Effect.runPromise(
        SessionRequestMeasurement.completePrimary(
          "ses-1",
          { outcome: "failed", endedAt: Date.now() },
          { attemptID: first!.attemptID, directory: dir },
        ),
      )
    })
    const lines = fs
      .readdirSync(dir)
      .flatMap((file) => fs.readFileSync(path.join(dir, file), "utf8").trim().split("\n"))
    expect(lines).toHaveLength(2)
    const completion = lines.map((line) => JSON.parse(line)).find((line) => line.coverage === "primary-completion")
    expect(completion).toBeDefined()
    expect(completion.record.outcome).toBe("completed")
    expect(completion.record.usage.input).toBe(10)
  })

  test("export folds sizes plus completion into one record and reports the manifest", async () => {
    const dir = mkdtemp()
    await withFlag(async () => {
      const first = await Effect.runPromise(
        SessionRequestMeasurement.recordPrimarySizes({ sessionID: "ses-1", request }, dir),
      )
      await Effect.runPromise(
        SessionRequestMeasurement.completePrimary(
          "ses-1",
          {
            outcome: "completed",
            endedAt: Date.now(),
            usage: { input: 10, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
            cost: { recordedUSD: null, estimatedUSD: 0.0001, source: "catalog" },
          },
          { attemptID: first!.attemptID, directory: dir },
        ),
      )
      await Effect.runPromise(SessionRequestMeasurement.recordPrimarySizes({ sessionID: "ses-2", request }, dir))
      const file = fs.readdirSync(dir)[0]
      fs.appendFileSync(path.join(dir, file), "not json at all\n")
    })
    const result = await Effect.runPromise(SessionRequestMeasurement.readExport(dir))
    expect(result.lines).toHaveLength(2)
    expect(result.manifest.records).toBe(2)
    expect(result.manifest.unfinished).toBe(1)
    expect(result.manifest.skippedLines).toBe(1)
    expect(result.manifest.coverage).toEqual(["primary-sizes", "primary-completion"])
    expect(result.manifest.gaps.length).toBeGreaterThan(0)
    const finished = result.lines.map((line) => JSON.parse(line)).find((record) => record.sessionID === "ses-1")
    expect(finished.outcome).toBe("completed")
    expect(finished.usage.input).toBe(10)
    expect(finished.cost.estimatedUSD).toBe(0.0001)
  })

  test("export filters by window and sessions and skips malformed records", async () => {
    const dir = mkdtemp()
    const write = (record: object, coverage = "primary-sizes") =>
      Effect.runPromise(SessionRequestMeasurement.writeLine(JSON.stringify({ coverage, record }), dir))
    const base = {
      schemaVersion: 1,
      measurementID: "m-1",
      sessionID: "ses-1",
      logicalRequestID: "lr-1",
      attemptID: "a-1",
      retryOf: null,
      goalID: null,
      taskID: null,
      role: null,
      attribution: "unknown",
      phase: "primary",
      providerID: "zen",
      modelID: "glm-4.6",
      endedAt: null,
      durationMs: null,
      outcome: "unknown",
      usage: { input: null, output: null, reasoning: null, cacheRead: null, cacheWrite: null },
      cost: { recordedUSD: null, estimatedUSD: null, source: "unknown" },
      toolCount: 0,
      messageCount: 0,
      estimates: { system: null, tools: null, history: null, method: "none" },
      sdkRetries: "uncounted",
    }
    await write({ ...base, startedAt: 1000 })
    await write({
      ...base,
      measurementID: "m-2",
      sessionID: "ses-2",
      logicalRequestID: "lr-2",
      attemptID: "a-2",
      startedAt: 9000,
    })
    await write({
      ...base,
      measurementID: "m-3",
      sessionID: "ses-3",
      logicalRequestID: "lr-3",
      attemptID: "a-3",
      startedAt: "oops",
    })
    const all = await Effect.runPromise(SessionRequestMeasurement.readExport(dir))
    expect(all.manifest.records).toBe(2)
    expect(all.manifest.skippedLines).toBe(1)
    const windowed = await Effect.runPromise(SessionRequestMeasurement.readExport(dir, { from: 5000 }))
    expect(windowed.lines).toHaveLength(1)
    const filtered = await Effect.runPromise(SessionRequestMeasurement.readExport(dir, { sessions: ["ses-1"] }))
    expect(filtered.lines).toHaveLength(1)
    expect(JSON.parse(filtered.lines[0]).sessionID).toBe("ses-1")
  })

  test("export: the first terminal completion wins; a later completion cannot overwrite it", async () => {
    const dir = mkdtemp()
    const begin = SessionRequestMeasurement.open({
      measurementID: "m-1",
      sessionID: "ses-1",
      logicalRequestID: "lr-1",
      attemptID: "a-1",
      phase: "primary",
      providerID: "zen",
      modelID: "glm-4.6",
      startedAt: 1,
      toolCount: 0,
      messageCount: 0,
    })
    const completed = {
      ...begin,
      outcome: "completed",
      endedAt: 100,
      durationMs: 99,
      usage: { input: 10, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      cost: { recordedUSD: null, estimatedUSD: 0.001, source: "catalog" },
    }
    const failedLater = {
      ...completed,
      outcome: "failed",
      endedAt: 200,
      durationMs: 199,
      usage: { input: 999, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    }
    // One file keeps line order deterministic: the completed line lands before the failed one.
    fs.writeFileSync(
      path.join(dir, "00000000-0000-4000-8000-000000000000.jsonl"),
      `${JSON.stringify({ coverage: "primary-completion", record: completed })}\n${JSON.stringify({ coverage: "primary-completion", record: failedLater })}\n`,
    )
    const result = await Effect.runPromise(SessionRequestMeasurement.readExport(dir))
    expect(result.manifest.records).toBe(1)
    expect(result.manifest.unfinished).toBe(0)
    const record = JSON.parse(result.lines[0])
    expect(record.outcome).toBe("completed")
    expect(record.usage.input).toBe(10)
  })

  test("export: a completion arriving before its begin stays terminal; the begin cannot reopen it", async () => {
    const dir = mkdtemp()
    const begin = SessionRequestMeasurement.open({
      measurementID: "m-1",
      sessionID: "ses-1",
      logicalRequestID: "lr-1",
      attemptID: "a-1",
      phase: "primary",
      providerID: "zen",
      modelID: "glm-4.6",
      startedAt: 1,
      toolCount: 0,
      messageCount: 0,
    })
    const completed = {
      ...begin,
      outcome: "completed",
      endedAt: 100,
      durationMs: 99,
      usage: { input: 10, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      cost: { recordedUSD: null, estimatedUSD: 0.001, source: "catalog" },
    }
    // Restart disorder: the completion is read before the begin of the same attempt.
    fs.writeFileSync(
      path.join(dir, "00000000-0000-4000-8000-000000000000.jsonl"),
      `${JSON.stringify({ coverage: "primary-completion", record: completed })}\n${JSON.stringify({ coverage: "primary-sizes", record: begin })}\n`,
    )
    const result = await Effect.runPromise(SessionRequestMeasurement.readExport(dir))
    expect(result.manifest.records).toBe(1)
    expect(result.manifest.unfinished).toBe(0)
    expect(JSON.parse(result.lines[0]).outcome).toBe("completed")
  })

  test("export is restart-safe: a fresh read reproduces the ledger, incomplete stays unknown", async () => {
    const dir = mkdtemp()
    const settled = SessionRequestMeasurement.open({
      measurementID: "m-1",
      sessionID: "ses-1",
      logicalRequestID: "lr-1",
      attemptID: "a-1",
      phase: "primary",
      providerID: "zen",
      modelID: "glm-4.6",
      startedAt: 1,
      toolCount: 0,
      messageCount: 0,
    })
    const interrupted = SessionRequestMeasurement.open({
      measurementID: "m-2",
      sessionID: "ses-1",
      logicalRequestID: "lr-2",
      attemptID: "a-2",
      phase: "primary",
      providerID: "zen",
      modelID: "glm-4.6",
      startedAt: 2,
      toolCount: 0,
      messageCount: 0,
    })
    // The daemon died after writing the begin of a-2: no completion ever lands for it.
    await Effect.runPromise(
      SessionRequestMeasurement.writeLine(JSON.stringify({ coverage: "primary-sizes", record: settled }), dir),
    )
    await Effect.runPromise(
      SessionRequestMeasurement.writeLine(
        JSON.stringify({
          coverage: "primary-completion",
          record: {
            ...settled,
            outcome: "completed",
            endedAt: 50,
            durationMs: 49,
            usage: { input: 3, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
            cost: { recordedUSD: null, estimatedUSD: null, source: "unknown" },
          },
        }),
        dir,
      ),
    )
    await Effect.runPromise(
      SessionRequestMeasurement.writeLine(JSON.stringify({ coverage: "primary-sizes", record: interrupted }), dir),
    )
    const first = await Effect.runPromise(SessionRequestMeasurement.readExport(dir))
    const second = await Effect.runPromise(SessionRequestMeasurement.readExport(dir))
    expect(second).toEqual(first)
    expect(first.manifest.records).toBe(2)
    expect(first.manifest.unfinished).toBe(1)
    const unfinished = first.lines.map((line) => JSON.parse(line)).find((record) => record.attemptID === "a-2")
    expect(unfinished.outcome).toBe("unknown")
    expect(unfinished.endedAt).toBeNull()
    expect(unfinished.durationMs).toBeNull()
  })

  test("export never passes malformed stored records through (repro: object goalID, arbitrary method)", async () => {
    const dir = mkdtemp()
    const opened = SessionRequestMeasurement.open({
      measurementID: "m-1",
      sessionID: "ses-1",
      logicalRequestID: "lr-1",
      attemptID: "a-1",
      phase: "primary",
      providerID: "zen",
      modelID: "glm-4.6",
      startedAt: 1,
      toolCount: 0,
      messageCount: 0,
    })
    const dirty = {
      ...opened,
      goalID: { privateText: "CANARY_PRIVATE_TEXT" },
      estimates: { ...opened.estimates, method: "CANARY_PRIVATE_TEXT" },
    }
    await Effect.runPromise(
      SessionRequestMeasurement.writeLine(JSON.stringify({ coverage: "primary-sizes", record: dirty }), dir),
    )
    await Effect.runPromise(
      SessionRequestMeasurement.writeLine(JSON.stringify({ coverage: "anything", record: opened }), dir),
    )
    const result = await Effect.runPromise(SessionRequestMeasurement.readExport(dir))
    expect(result.manifest.records).toBe(0)
    expect(result.manifest.skippedLines).toBe(2)
    expect(JSON.stringify(result)).not.toContain("CANARY_PRIVATE_TEXT")
  })

  test("a NaN completion cannot fail the caller and leaves the attempt open (repro 2)", async () => {
    const dir = mkdtemp()
    await withFlag(async () => {
      const opened = await Effect.runPromise(
        SessionRequestMeasurement.recordPrimarySizes({ sessionID: "ses-1", request }, dir),
      )
      await Effect.runPromise(
        SessionRequestMeasurement.completePrimary(
          "ses-1",
          {
            outcome: "completed",
            endedAt: Date.now(),
            usage: { input: Number.NaN, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
          },
          { attemptID: opened!.attemptID, directory: dir },
        ),
      )
      expect(SessionRequestMeasurement.pendingAttempt("ses-1")).toBeDefined()
      // Only the begin line exists; the invalid completion was dropped, not written.
      const before = fs
        .readdirSync(dir)
        .flatMap((file) => fs.readFileSync(path.join(dir, file), "utf8").trim().split("\n"))
      expect(before).toHaveLength(1)
      // A later valid completion still settles the same attempt.
      await Effect.runPromise(
        SessionRequestMeasurement.completePrimary(
          "ses-1",
          {
            outcome: "completed",
            endedAt: Date.now(),
            usage: { input: 3, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
          },
          { attemptID: opened!.attemptID, directory: dir },
        ),
      )
      expect(SessionRequestMeasurement.pendingAttempt("ses-1")).toBeUndefined()
      const after = fs
        .readdirSync(dir)
        .flatMap((file) => fs.readFileSync(path.join(dir, file), "utf8").trim().split("\n"))
      expect(after).toHaveLength(2)
      const completion = after.map((line) => JSON.parse(line)).find((line) => line.coverage === "primary-completion")
      expect(completion.record.usage.input).toBe(3)
    })
  })

  test("a completion for a superseded attempt ID is a no-op", async () => {
    const dir = mkdtemp()
    await withFlag(async () => {
      await Effect.runPromise(SessionRequestMeasurement.recordPrimarySizes({ sessionID: "ses-1", request }, dir))
      await Effect.runPromise(
        SessionRequestMeasurement.completePrimary(
          "ses-1",
          { outcome: "failed", endedAt: Date.now() },
          { attemptID: "not-the-pending-one", directory: dir },
        ),
      )
      expect(SessionRequestMeasurement.pendingAttempt("ses-1")).toBeDefined()
      const lines = fs
        .readdirSync(dir)
        .flatMap((file) => fs.readFileSync(path.join(dir, file), "utf8").trim().split("\n"))
      expect(lines).toHaveLength(1)
    })
  })

  test("only an explicit retry token links attempts; a new task never joins a failed or cancelled one", async () => {
    const dir = mkdtemp()
    await withFlag(async () => {
      const first = await Effect.runPromise(
        SessionRequestMeasurement.recordPrimarySizes({ sessionID: "ses-1", request }, dir),
      )
      expect(first).toBeDefined()
      await Effect.runPromise(
        SessionRequestMeasurement.completePrimary(
          "ses-1",
          { outcome: "failed", endedAt: Date.now() },
          {
            attemptID: first!.attemptID,
            directory: dir,
          },
        ),
      )
      // Without a token the next request starts a new logical request, even after a failure.
      const unrelated = await Effect.runPromise(
        SessionRequestMeasurement.recordPrimarySizes({ sessionID: "ses-1", request }, dir),
      )
      const unrelatedAttempt = SessionRequestMeasurement.pendingAttempt("ses-1")
      expect(unrelatedAttempt?.retryOf).toBeNull()
      expect(unrelatedAttempt?.logicalRequestID).toBe(unrelatedAttempt?.attemptID)
      await Effect.runPromise(
        SessionRequestMeasurement.completePrimary(
          "ses-1",
          { outcome: "cancelled", endedAt: Date.now() },
          {
            attemptID: unrelated!.attemptID,
            directory: dir,
          },
        ),
      )
      // With the runner's token the retry joins the cancelled attempt's logical request.
      const retried = await Effect.runPromise(
        SessionRequestMeasurement.recordPrimarySizes({ sessionID: "ses-1", request, retryOf: unrelated! }, dir),
      )
      const retry = SessionRequestMeasurement.pendingAttempt("ses-1")
      expect(retry?.attemptID).toBe(retried?.attemptID)
      expect(retry?.retryOf).toBe(unrelated!.attemptID)
      expect(retry?.logicalRequestID).toBe(unrelated!.logicalRequestID)
    })
  })
})
