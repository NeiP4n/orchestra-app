import { describe, expect, test } from "bun:test"
import { McpSelect } from "../src/mcp/select"
import { McpCatalog } from "../src/mcp/catalog"

describe("McpSelect.rank", () => {
  test("ranks English needs deterministically", () => {
    const browser = McpSelect.rank("browser automation")
    expect(browser.length).toBeGreaterThan(0)
    expect(browser[0]!.entry.id).toBe("playwright")
    expect(browser[0]!.reasons).toContain("browser")
    expect(browser[0]!.confidence).toBeGreaterThanOrEqual(McpSelect.CONFIDENCE_THRESHOLD)
    const docs = McpSelect.rank("library documentation")
    expect(docs.map((match) => match.entry.id)).toContain("context7")
    expect(docs[0]!.entry.id).toBe("context7")
    expect(McpSelect.rank("zzqqx nonexistent")).toEqual([])
    expect(McpSelect.rank("")).toEqual([])
    expect(McpSelect.rank("browser automation")[0]!.entry.id).toBe(browser[0]!.entry.id)
  })

  test("one generic word is not a match", () => {
    expect(McpSelect.rank("use")).toEqual([])
    expect(McpSelect.rank("when")).toEqual([])
  })

  test("understands Russian needs", () => {
    const browser = McpSelect.rank("автоматизация браузера")
    expect(browser.length).toBeGreaterThan(0)
    expect(browser[0]!.entry.id).toBe("playwright")
    const docs = McpSelect.rank("документация библиотеки")
    expect(docs[0]!.entry.id).toBe("context7")
    const code = McpSelect.rank("поиск по коду")
    expect(code.map((match) => match.entry.id)).toContain("serena")
    expect(code[0]!.entry.id).toBe("serena")
    expect(McpSelect.rank("нужен playwright пожалуйста")[0]!.entry.id).toBe("playwright")
  })

  test("chrome-devtools is found by name and falls back to playwright, not the other way round", () => {
    // "browser automation" still picks playwright first: chrome-devtools is
    // the Chrome-specific alternative, found by name.
    expect(McpSelect.rank("browser automation")[0]!.entry.id).toBe("playwright")
    expect(McpSelect.rank("chrome devtools")[0]!.entry.id).toBe("chrome-devtools")
    expect(McpSelect.rank("chrome devtools").map((match) => match.entry.id)).toContain("chrome-devtools")
    expect(McpSelect.fallbackChain("chrome-devtools")).toEqual([
      { kind: "mcp", server: "playwright" },
      { kind: "native", tools: ["browser", "playtest"] },
    ])
  })

  test("a server with a good rating outranks an untried one on an equal textual score", () => {
    const plain = McpSelect.rank("документация")
    expect(plain[0]!.entry.id).toBe("context7")
    const rated = McpSelect.rank("документация", process.platform, new Map([
      ["context7", { calls: 10, successes: 0, failures: 10, totalLatencyMs: 0, totalOutputTokens: 0 }],
      ["deepwiki", { calls: 10, successes: 10, failures: 0, totalLatencyMs: 1000, totalOutputTokens: 0 }],
    ]))
    expect(rated[0]!.entry.id).toBe("deepwiki")
  })
})

describe("McpSelect.selectForTask", () => {
  test("a Russian browser need picks playwright with its fallback chain, explained", () => {
    const decision = McpSelect.selectForTask("автоматизация браузера")
    expect(decision.kind).toBe("mcp")
    if (decision.kind !== "mcp") throw new Error("expected an mcp decision")
    expect(decision.server).toBe("playwright")
    expect(decision.chain).toEqual([
      { kind: "mcp", server: "agent-desktop" },
      { kind: "native", tools: ["browser", "playtest"] },
    ])
    expect(decision.explanation).toContain("playwright")
    expect(decision.explanation).toContain("agent-desktop")
  })

  test("context7 falls back to deepwiki, serena and xerj fall back to each other then native", () => {
    expect(McpSelect.fallbackChain("context7")).toEqual([{ kind: "mcp", server: "deepwiki" }])
    expect(McpSelect.fallbackChain("serena")).toEqual([
      { kind: "mcp", server: "xerj" },
      { kind: "native", tools: ["symbols", "grep", "read"] },
    ])
    expect(McpSelect.fallbackChain("xerj")).toEqual([
      { kind: "mcp", server: "serena" },
      { kind: "native", tools: ["symbols", "grep", "read"] },
    ])
    const docs = McpSelect.selectForTask("документация библиотеки")
    expect(docs.kind).toBe("mcp")
    if (docs.kind === "mcp") {
      expect(docs.server).toBe("context7")
      expect(docs.chain).toEqual([{ kind: "mcp", server: "deepwiki" }])
    }
  })

  test("a need native tools cover is answered with the native analogue, not a server", () => {
    const memory = McpSelect.selectForTask("запомнить это на будущее")
    expect(memory.kind).toBe("native")
    if (memory.kind === "native") expect(memory.analogue.id).toBe("memory")
    const git = McpSelect.selectForTask("посмотреть историю коммитов в git")
    expect(git.kind).toBe("native")
    if (git.kind === "native") expect(git.analogue.id).toBe("git")
    const time = McpSelect.selectForTask("какое сегодня число и время")
    expect(time.kind).toBe("native")
    if (time.kind === "native") expect(time.analogue.id).toBe("time")
  })

  test("an unmatchable need asks instead of guessing, with a card", () => {
    const decision = McpSelect.selectForTask("zzqqx nonexistent capability")
    expect(decision.kind).toBe("ask")
    if (decision.kind !== "ask") throw new Error("expected an ask decision")
    expect(decision.confidence).toBe(0)
    expect(decision.card.kind).toBe("ask")
    expect(decision.card.title).toContain("zzqqx")
    expect(decision.card.options.length).toBeGreaterThan(0)
    expect(decision.explanation).toContain("No catalog server matches")
  })

  test("a tie at the top asks instead of picking by sort order", () => {
    const decision = McpSelect.selectForTask("документация")
    expect(decision.kind).toBe("ask")
    if (decision.kind !== "ask") throw new Error("expected an ask decision")
    expect(decision.candidates.map((match) => match.entry.id)).toContain("context7")
    expect(decision.candidates.map((match) => match.entry.id)).toContain("deepwiki")
    expect(decision.card.recommend).toBe("context7")
  })
})

describe("McpSelect native analogues", () => {
  test("every native class is documented in the catalog", () => {
    const ids = McpCatalog.nativeAnalogues.map((analogue) => analogue.id)
    for (const id of ["web-search", "memory", "sequential-thinking", "filesystem", "database", "task-tracker", "fetch", "git", "time"])
      expect(ids).toContain(id)
    for (const analogue of McpCatalog.nativeAnalogues) {
      expect(analogue.nativeTools.length).toBeGreaterThan(0)
      expect(analogue.keywords.length).toBeGreaterThan(0)
    }
  })
})
