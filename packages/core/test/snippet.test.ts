import { describe, expect, it } from "bun:test"
import {
  deduplicateSnippets,
  defaultSnippets,
  rankSnippets,
  render,
  scoreSnippet,
  type Snippet,
} from "../src/instructions/snippets.js"

describe("Snippet Ranking & Relevance", () => {
  const customSnippets: ReadonlyArray<Snippet> = [
    {
      name: "bun-test",
      template: "bun test <target>",
      description: "Run unit tests with bun runner",
      stack: ["bun", "typescript"],
      tags: ["test", "bun"],
    },
    {
      name: "cargo-check",
      template: "cargo check",
      description: "Typecheck rust workspace",
      stack: ["rust", "cargo"],
      tags: ["rust", "cargo"],
    },
    {
      name: "py-pytest",
      template: "pytest <path>",
      description: "Run python tests",
      stack: ["python"],
      tags: ["test", "python"],
    },
    {
      name: "grep-find",
      template: "grep({ pattern })",
      description: "Search workspace content",
      requiredTool: "grep",
      stack: ["grep"],
    },
    {
      name: "desktop-run",
      template: "tools['desktop-commander'].start_process()",
      description: "Run async desktop command",
      requiredTool: "desktop-commander",
      stack: ["desktop-commander"],
    },
  ]

  it("ranks snippets higher when projectStack matches", () => {
    const ranked = rankSnippets(customSnippets, {
      projectStack: ["rust", "cargo"],
    })

    expect(ranked[0]?.name).toBe("cargo-check")
    expect(scoreSnippet(customSnippets.find((s) => s.name === "cargo-check")!, {
      projectStack: ["rust"],
    })).toBeGreaterThan(
      scoreSnippet(customSnippets.find((s) => s.name === "py-pytest")!, {
        projectStack: ["rust"],
      }),
    )
  })

  it("prioritizes snippets matching active tools and filters unavailable required tools", () => {
    const ranked = rankSnippets(customSnippets, {
      availableTools: ["grep"],
      activeTools: ["grep"],
      projectStack: ["typescript"],
    })

    expect(ranked.some((s) => s.name === "desktop-run")).toBeFalse()
    expect(ranked[0]?.name).toBe("grep-find")
  })

  it("ranks snippets by query terms", () => {
    const ranked = rankSnippets(customSnippets, {
      query: "python test execution",
    })

    expect(ranked[0]?.name).toBe("py-pytest")
  })

  it("deduplicates snippets by name and template", () => {
    const duplicates: ReadonlyArray<Snippet> = [
      {
        name: "test-target",
        template: "bun test foo.test.ts",
        description: "first version",
      },
      {
        name: "test-target",
        template: "bun test bar.test.ts",
        description: "duplicate name",
      },
      {
        name: "another-name",
        template: "bun test foo.test.ts",
        description: "duplicate template",
      },
      {
        name: "unique-name",
        template: "bun run check",
        description: "unique entry",
      },
    ]

    const deduped = deduplicateSnippets(duplicates)
    expect(deduped).toHaveLength(2)
    expect(deduped.map((s) => s.name)).toEqual(["test-target", "unique-name"])
  })

  it("enforces token-saving limit on ranked snippet count", () => {
    const ranked = rankSnippets(defaultSnippets, {
      limit: 3,
    })

    expect(ranked).toHaveLength(3)
  })

  it("renders ranked and limited snippets within xml tags", () => {
    const rendered = render(defaultSnippets, {
      projectStack: ["bun", "typescript"],
      activeTools: ["grep"],
      limit: 2,
    })

    expect(rendered).toContain("<action-snippets>")
    expect(rendered).toContain("</action-snippets>")
    const lines = rendered.split("\n").filter((line) => line.startsWith("- "))
    expect(lines).toHaveLength(2)
  })

  it("maintains backward compatibility with array of tool names", () => {
    const rendered = render(defaultSnippets, ["grep", "read"])
    expect(rendered).toContain("narrow-search")
    expect(rendered).toContain("bounded-read")
    expect(rendered).not.toContain("bg-process")
  })
})
