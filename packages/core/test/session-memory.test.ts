import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { Instructions } from "@orchestra/core/instructions/index"
import { MemoryEngine } from "@orchestra/core/memory/engine"
import { SessionMemory } from "@orchestra/core/memory/session"
import { SessionHandoff } from "@orchestra/core/session/handoff"

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

const project = async () => mkdtemp(path.join(os.tmpdir(), "orchestra-session-memory-"))

const capture = (directory: string, sessionID: string, toolUseID: string, tool: string, input: string, output: string, engine?: MemoryEngine, error?: string) =>
  run(
    SessionMemory.captureToolUse({
      directory,
      sessionID,
      toolUseID,
      tool,
      inputText: input,
      outputText: output,
      ...(error !== undefined ? { error } : {}),
      ...(engine !== undefined ? { engine } : {}),
    }),
  )

describe("session memory (L3)", () => {
  test("tool I/O is truncated at 64 KiB with a byte-count marker", () => {
    const big = "x".repeat(70_000)
    const cut = SessionMemory.truncateToolIO(big)
    expect(new TextEncoder().encode(cut).length).toBeLessThanOrEqual(SessionMemory.TOOL_IO_MAX_BYTES)
    expect(cut).toContain("…[truncated: 70000 bytes]")
    expect(SessionMemory.truncateToolIO("small")).toBe("small")
    // Multibyte text: the cap is in bytes, not characters.
    const cyrillic = "я".repeat(40_000)
    const cutRu = SessionMemory.truncateToolIO(cyrillic)
    expect(new TextEncoder().encode(cutRu).length).toBeLessThanOrEqual(SessionMemory.TOOL_IO_MAX_BYTES)
    expect(cutRu).toContain("…[truncated: 80000 bytes]")
  })

  test("observation classification covers the claude-mem vocabulary", () => {
    const typeOf = (tool: string, input: string, output: string, failed = false) =>
      SessionMemory.classifyObservation(tool, input, output, failed)
    expect(typeOf("edit", "решено: использовать bun", "")).toBe("decision")
    expect(typeOf("edit", "fix the export guard", "error fixed")).toBe("bugfix")
    expect(typeOf("shell", "run the failing test", "Error: boom", true)).toBe("bugfix")
    expect(typeOf("edit", "add a new export command", "created")).toBe("feature")
    expect(typeOf("edit", "рефакторинг: вынести парсер", "")).toBe("refactor")
    expect(typeOf("read", "", "оказалось, что конфиг лежит в другом месте")).toBe("discovery")
    expect(typeOf("read", "list files", "a.ts\nb.ts")).toBe("change")
  })

  test("the chill filter drops tiny reads but keeps failures, writes and big outputs", () => {
    const sessionID = "ses_filter"
    const tinyRead = SessionMemory.buildObservation({
      sessionID,
      toolUseID: "call_1",
      tool: "read",
      inputText: "read a.ts",
      outputText: "ok",
    })
    expect(tinyRead).toBeUndefined()
    const failedRead = SessionMemory.buildObservation({
      sessionID,
      toolUseID: "call_2",
      tool: "read",
      inputText: "read a.ts",
      outputText: "",
      error: "ENOENT",
    })
    expect(failedRead?.type).toBe("bugfix")
    const edit = SessionMemory.buildObservation({
      sessionID,
      toolUseID: "call_3",
      tool: "edit",
      inputText: "edit a.ts",
      outputText: "done",
    })
    expect(edit).not.toBeUndefined()
    const bigRead = SessionMemory.buildObservation({
      sessionID,
      toolUseID: "call_4",
      tool: "read",
      inputText: "read big.ts",
      outputText: "x".repeat(500),
    })
    expect(bigRead).not.toBeUndefined()
  })

  test("capture is idempotent on (session + tool call): one journal line, one engine observation", async () => {
    const directory = await project()
    const engine = MemoryEngine.open(":memory:")
    const input = {
      directory,
      sessionID: "ses_idem",
      toolUseID: "call_1",
      tool: "edit",
      inputText: "edit a.ts: fix the guard",
      outputText: "patched",
    }
    expect(await run(SessionMemory.captureToolUse({ ...input, engine }))).toEqual({ status: "recorded" })
    expect(await run(SessionMemory.captureToolUse({ ...input, engine }))).toEqual({ status: "duplicate" })
    expect(await run(SessionMemory.captureToolUse({ ...input, engine }))).toEqual({ status: "duplicate" })
    const journal = await readFile(SessionMemory.pathsFor(directory, "ses_idem").journal, "utf8")
    expect(journal.trim().split("\n")).toHaveLength(1)
    expect(engine.stats().observations).toBe(1)
    // A different tool call in the same session is a new observation; the same
    // tool call id in another session is a different key.
    expect(
      await run(SessionMemory.captureToolUse({ ...input, toolUseID: "call_2", engine })),
    ).toEqual({ status: "recorded" })
    expect(
      await run(SessionMemory.captureToolUse({ ...input, sessionID: "ses_other", engine })),
    ).toEqual({ status: "recorded" })
    expect(engine.stats().observations).toBe(3)
    engine.close()
  })

  test("filtered calls write nothing", async () => {
    const directory = await project()
    expect(await capture(directory, "ses_noise", "call_1", "read", "read a.ts", "ok")).toEqual({
      status: "filtered",
    })
    await expect(readFile(SessionMemory.pathsFor(directory, "ses_noise").journal, "utf8")).rejects.toThrow()
  })

  test("finalize writes memory.md and guarantees handoff.md; a fake summarizer is used when given", async () => {
    const directory = await project()
    await capture(directory, "ses_fin", "call_1", "edit", "решено: перейти на bun", "patched")
    await capture(directory, "ses_fin", "call_2", "shell", "run tests", "12 passed")
    const result = await run(
      SessionMemory.finalizeSession(directory, "ses_fin", {
        summarize: () => Effect.succeed("# Session memory — ses_fin\n\n## Decisions\n- bun it is\n"),
      }),
    )
    expect(result.status).toBe("finalized")
    if (result.status === "finalized") {
      expect(result.observations).toBe(2)
      expect(result.bytes).toBeLessThanOrEqual(SessionMemory.MEMORY_MAX_BYTES)
    }
    const memory = await readFile(SessionMemory.pathsFor(directory, "ses_fin").memory, "utf8")
    expect(memory).toContain("bun it is")
    const handoff = await readFile(SessionMemory.pathsFor(directory, "ses_fin").handoff, "utf8")
    expect(handoff.startsWith(SessionHandoff.STUB_MARKER)).toBe(true)
  })

  test("finalize never overwrites an agent-written handoff", async () => {
    const directory = await project()
    await run(
      SessionHandoff.write(directory, "ses_agent", {
        reason: "user",
        works: "Everything works.",
        broken: "Nothing broken.",
        nextStep: "Ship it.",
      }),
    )
    await capture(directory, "ses_agent", "call_1", "edit", "fix the guard", "patched")
    await run(SessionMemory.finalizeSession(directory, "ses_agent"))
    const handoff = await readFile(SessionMemory.pathsFor(directory, "ses_agent").handoff, "utf8")
    expect(handoff).toContain("Ship it.")
    expect(handoff.startsWith(SessionHandoff.STUB_MARKER)).toBe(false)
  })

  test("empty sessions are skipped (no summary, no model call) but still get a handoff", async () => {
    const directory = await project()
    let called = false
    const result = await run(
      SessionMemory.finalizeSession(directory, "ses_empty", {
        summarize: () => {
          called = true
          return Effect.succeed("must not happen")
        },
      }),
    )
    expect(called).toBe(false)
    expect(result).toEqual({ status: "skipped", reason: "nothing-to-remember", observations: 0 })
    const handoff = await readFile(SessionMemory.pathsFor(directory, "ses_empty").handoff, "utf8")
    expect(handoff.startsWith(SessionHandoff.STUB_MARKER)).toBe(true)
    await expect(readFile(SessionMemory.pathsFor(directory, "ses_empty").memory, "utf8")).rejects.toThrow()
  })

  test("a failing summarizer falls back to the extractive summary", async () => {
    const directory = await project()
    await capture(directory, "ses_fallback", "call_1", "edit", "решено: использовать bun", "patched")
    const result = await run(
      SessionMemory.finalizeSession(directory, "ses_fallback", {
        summarize: () => Effect.fail(new Error("provider down")),
      }),
    )
    expect(result.status).toBe("finalized")
    const memory = await readFile(SessionMemory.pathsFor(directory, "ses_fallback").memory, "utf8")
    expect(memory).toContain("## Decisions")
  })

  test("memory.md never exceeds 8 KiB: decisions survive, overflow goes to scratch.md", async () => {
    const directory = await project()
    await capture(directory, "ses_big", "call_decision", "edit", "решено: перейти на bun", "patched")
    for (let i = 0; i < 60; i++) {
      await capture(
        directory,
        "ses_big",
        `call_${i}`,
        "edit",
        `edit file-${i}.ts: change number ${i}`,
        `patched file-${i}.ts with a long description ${"y".repeat(120)}`,
      )
    }
    const result = await run(SessionMemory.finalizeSession(directory, "ses_big"))
    expect(result.status).toBe("finalized")
    const memory = await readFile(SessionMemory.pathsFor(directory, "ses_big").memory, "utf8")
    expect(new TextEncoder().encode(memory).length).toBeLessThanOrEqual(SessionMemory.MEMORY_MAX_BYTES)
    expect(memory).toContain("## Decisions")
    if (result.status === "finalized") expect(result.scratched).toBe(true)
    const scratch = await readFile(SessionMemory.pathsFor(directory, "ses_big").scratch, "utf8")
    expect(scratch.length).toBeGreaterThan(memory.length)
  })

  test("trimMemoryToLimit keeps decisions first and stays within the limit", () => {
    const observations = Array.from({ length: 100 }, (_, i) => ({
      sessionID: "ses_trim",
      toolUseID: `call_${i}`,
      tool: "edit",
      type: (i === 0 ? "decision" : "change") as SessionMemory.ObservationType,
      title: `change ${i} ${"z".repeat(100)}`,
      text: `change ${i}`,
      failed: false,
      createdAt: 0,
    }))
    const full = SessionMemory.renderMemory("ses_trim", observations)
    expect(new TextEncoder().encode(full).length).toBeGreaterThan(SessionMemory.MEMORY_MAX_BYTES)
    const trimmed = SessionMemory.trimMemoryToLimit(full)
    expect(new TextEncoder().encode(trimmed.text).length).toBeLessThanOrEqual(SessionMemory.MEMORY_MAX_BYTES)
    expect(trimmed.text).toContain("## Decisions")
    expect(trimmed.omitted).toBeGreaterThan(0)
    // Unstructured text is cut by bytes, not dropped.
    const prose = "p".repeat(20_000)
    const cut = SessionMemory.trimMemoryToLimit(prose)
    expect(new TextEncoder().encode(cut.text).length).toBeLessThanOrEqual(SessionMemory.MEMORY_MAX_BYTES)
    expect(cut.text).toContain("…[truncated]")
  })

  test("start budget: 12 000 characters, memory.md first, empty memory costs 0", async () => {
    const directory = await project()
    const paths = SessionMemory.pathsFor(directory, "ses_start")
    await mkdir(paths.dir, { recursive: true })
    await writeFile(paths.memory, "m".repeat(20_000), "utf8")
    await writeFile(paths.handoff, "h".repeat(500), "utf8")
    const loaded = await run(SessionMemory.loadStartContext(directory, "ses_start"))
    expect(loaded.length).toBeLessThanOrEqual(SessionMemory.START_BUDGET_CHARS)
    expect(loaded.startsWith("<session-memory>")).toBe(true)
    expect(loaded).not.toContain("<session-handoff>")
    expect(await run(SessionMemory.loadStartContext(directory, "ses_missing"))).toBe("")
    expect(SessionMemory.applyStartBudget("", "")).toBe("")
  })

  test("checkpoint survives an interruption between checkpoint and compaction", async () => {
    const directory = await project()
    const paths = SessionMemory.pathsFor(directory, "ses_ckpt")
    await mkdir(paths.dir, { recursive: true })
    await writeFile(paths.memory, "# Session memory — ses_ckpt\n\n## Decisions\n- bun it is\n", "utf8")
    await writeFile(paths.handoff, "# Handoff — stopped\n", "utf8")
    const checkpoint = await run(SessionMemory.checkpointBeforeCompaction(directory, "ses_ckpt"))
    expect(checkpoint.memory).toBe(true)
    expect(checkpoint.handoff).toBe(true)
    expect(checkpoint.summary).toContain("bun it is")
    // The compaction never runs (interruption): the snapshot is still on disk.
    expect(await readFile(paths.checkpointMemory, "utf8")).toContain("bun it is")
    expect(await readFile(paths.checkpointHandoff, "utf8")).toContain("Handoff")
    // Even if the live memory.md is lost afterwards, the checkpoint re-injects it.
    await rm(paths.memory)
    expect(await run(SessionMemory.loadCheckpointSummary(directory, "ses_ckpt"))).toContain("bun it is")
    // Re-inject rides the checkpoint message.
    expect(SessionMemory.reinjectSummary("summary", "memory text")).toContain("<session-memory>")
    expect(SessionMemory.reinjectSummary("summary", "")).toBe("summary")
    // Nothing to snapshot is not an error.
    expect(await run(SessionMemory.checkpointBeforeCompaction(directory, "ses_none"))).toEqual(
      expect.objectContaining({ memory: false, handoff: false }),
    )
  })

  test("the cheap-model pick goes through the B10 router (tier trivial, cheapest first)", () => {
    const catalog = [
      { id: "flash", providerID: "anymodel", variants: [{ id: "fast" }], cost: [{ input: 0.1, output: 0.2 }] },
      { id: "pro", providerID: "anymodel", variants: [{ id: "fast" }], cost: [{ input: 5, output: 10 }] },
      { id: "unpriced", providerID: "anymodel", variants: [{ id: "fast" }], cost: [] },
    ]
    const picked = SessionMemory.pickSummaryModel(catalog)
    expect(picked.id).toBe("flash")
    expect(picked.providerID).toBe("anymodel")
    expect(() => SessionMemory.pickSummaryModel([])).toThrow("empty model catalog")
    expect(SessionMemory.worthSummarizing(0)).toBe(false)
    expect(SessionMemory.worthSummarizing(1)).toBe(true)
    expect(SessionMemory.buildSummaryPrompt("ses_x", [])).toContain("ses_x")
  })

  test("the instruction source is removed when memory is empty and capped when it is not", async () => {
    const directory = await project()
    const [empty] = SessionMemory.instructions(directory, "ses_none")
    expect(await run(empty.read)).toEqual(Instructions.removed)
    const paths = SessionMemory.pathsFor(directory, "ses_full")
    await mkdir(paths.dir, { recursive: true })
    await writeFile(paths.memory, "m".repeat(20_000), "utf8")
    const [full] = SessionMemory.instructions(directory, "ses_full")
    const value = await run(full.read)
    expect(typeof value).toBe("string")
    expect((value as string).length).toBeLessThanOrEqual(SessionMemory.START_BUDGET_CHARS)
  })
})

describe("session engine acquisition degradation", () => {
  test("an operational open failure warns once per failure streak, retries on every call and recovers", async () => {
    const directory = await project()
    // The database path exists as a DIRECTORY: the eager engine open fails
    // operationally (permissions/lock/damaged database behave the same way),
    // while the journal directory stays writable.
    const blocker = path.join(directory, ".orchestra", "memory.db")
    await mkdir(path.dirname(blocker), { recursive: true })
    await mkdir(blocker)

    const first = SessionMemory.tryOpenSessionEngine(directory)
    expect(first.engine).toBeUndefined()
    expect(first.degradation?.kind).toBe("operational")
    expect(first.degradation?.warn).toBe(true)
    if (first.degradation?.kind === "operational") expect(first.degradation.cause).toBeDefined()

    // Every call retries the open; the warning is deduped per failure streak.
    const second = SessionMemory.tryOpenSessionEngine(directory)
    expect(second.engine).toBeUndefined()
    expect(second.degradation?.kind).toBe("operational")
    expect(second.degradation?.warn).toBe(false)

    // The journal stays the record while the engine is down.
    const result = await capture(directory, "ses_degraded", "call_1", "edit", "edit a.ts", "done")
    expect(result.status).toBe("recorded")
    const journal = await readFile(SessionMemory.pathsFor(directory, "ses_degraded").journal, "utf8")
    expect(journal).toContain("edit a.ts")

    // Recovery: with the blockage gone the next call opens the real engine,
    // and the cleared streak means a later failure warns again.
    await rm(blocker, { recursive: true, force: true })
    const recovered = SessionMemory.tryOpenSessionEngine(directory)
    expect(recovered.engine).toBeDefined()
    expect(recovered.degradation).toBeUndefined()
    recovered.engine?.close()

    await rm(directory, { recursive: true, force: true })
  })

  test("a working directory still opens the engine and records through it", async () => {
    const directory = await project()
    const opened = SessionMemory.tryOpenSessionEngine(directory)
    expect(opened.engine).toBeDefined()
    expect(opened.degradation).toBeUndefined()
    const result = await capture(directory, "ses_engine", "call_1", "edit", "edit b.ts", "done", opened.engine)
    expect(result.status).toBe("recorded")
    await rm(directory, { recursive: true, force: true })
  })
})
