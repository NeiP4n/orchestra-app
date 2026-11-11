import { describe, expect, test } from "bun:test"
import { McpSelect } from "../src/mcp/select"
import { McpCatalog } from "../src/mcp/catalog"

describe("McpSelect.rank", () => {
  test("ranks English needs deterministically", () => {
    const browser = McpSelect.rank("browser automation")
    expect(browser).toEqual([])
    const docs = McpSelect.rank("library documentation")
    expect(docs.map((match) => match.entry.id)).toContain("context7")
    expect(docs[0]!.entry.id).toBe("context7")
    expect(McpSelect.rank("zzqqx nonexistent")).toEqual([])
    expect(McpSelect.rank("")).toEqual([])
    expect(McpSelect.rank("browser automation")).toEqual(browser)
  })

  test("one generic word is not a match", () => {
    expect(McpSelect.rank("use")).toEqual([])
    expect(McpSelect.rank("when")).toEqual([])
  })

  test("understands Russian needs", () => {
    const browser = McpSelect.rank("автоматизация браузера")
    expect(browser).toEqual([])
    const docs = McpSelect.rank("документация библиотеки")
    expect(docs[0]!.entry.id).toBe("context7")
    const code = McpSelect.rank("поиск по коду")
    expect(code.map((match) => match.entry.id)).toContain("serena")
    expect(code[0]!.entry.id).toBe("serena")
    expect(McpSelect.rank("нужен playwright пожалуйста")).toEqual([])
  })

  test("retired browser IDs resolve to native browser tools, never another MCP launch", () => {
    for (const need of ["browser automation", "chrome devtools", "playwright"]) {
      expect(McpSelect.rank(need)).toEqual([])
      expect(McpSelect.selectForTask(need)).toMatchObject({
        kind: "native",
        analogue: { id: "browser", nativeTools: ["browser", "playtest"] },
      })
    }
    for (const id of ["playwright", "chrome-devtools"])
      expect(McpSelect.fallbackChain(id)).toEqual([{ kind: "native", tools: ["browser", "playtest"] }])
  })

  test("a server with a good rating outranks an untried one on an equal textual score", () => {
    const plain = McpSelect.rank("документация")
    expect(plain[0]!.entry.id).toBe("context7")
    const rated = McpSelect.rank(
      "документация",
      process.platform,
      new Map([
        ["context7", { calls: 10, successes: 0, failures: 10, totalLatencyMs: 0, totalOutputTokens: 0 }],
        ["deepwiki", { calls: 10, successes: 10, failures: 0, totalLatencyMs: 1000, totalOutputTokens: 0 }],
      ]),
    )
    expect(rated[0]!.entry.id).toBe("deepwiki")
  })
})

describe("McpSelect.selectForTask", () => {
  test("a Russian browser need names the native tool instead of installing a duplicate", () => {
    const decision = McpSelect.selectForTask("автоматизация браузера")
    expect(decision.kind).toBe("native")
    if (decision.kind !== "native") throw Error("expected native browser")
    expect(decision.analogue.id).toBe("browser")
    expect(decision.explanation).toContain("browser")
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
    for (const id of [
      "web-search",
      "memory",
      "sequential-thinking",
      "filesystem",
      "database",
      "task-tracker",
      "fetch",
      "git",
      "time",
    ])
      expect(ids).toContain(id)
    for (const analogue of McpCatalog.nativeAnalogues) {
      expect(analogue.nativeTools.length).toBeGreaterThan(0)
      expect(analogue.keywords.length).toBeGreaterThan(0)
    }
  })
})

describe("operator-disabled candidates", () => {
  test("OFF candidates are absent from ranking, ask-cards and fallback", () => {
    const disabled = new Set(["context7", "deepwiki"])
    expect(
      McpSelect.rank("documentation library", "linux", undefined, disabled).some((row) => disabled.has(row.entry.id)),
    ).toBe(false)
    const decision = McpSelect.selectForTask("documentation library", { disabled })
    if (decision.kind === "ask") {
      expect(decision.card.options.some((id) => disabled.has(id))).toBe(false)
      expect(decision.candidates.some((row) => disabled.has(row.entry.id))).toBe(false)
    }
    if (decision.kind === "mcp") {
      expect(disabled.has(decision.server)).toBe(false)
      expect(decision.chain.some((link) => link.kind === "mcp" && disabled.has(link.server))).toBe(false)
    }
    const docs = McpSelect.selectForTask("context7 library documentation", { disabled: new Set(["deepwiki"]) })
    expect(docs.kind).toBe("mcp")
    if (docs.kind === "mcp")
      expect(docs.chain.some((link) => link.kind === "mcp" && link.server === "deepwiki")).toBe(false)
  })
})
