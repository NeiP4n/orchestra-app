import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { InstructionRouter } from "@orchestra/core/instructions/router"

const long = (topic: string) => `- ${topic} rule that only matters there.\n`.repeat(30)

const file = [
  "- Shared rule for everyone.",
  "",
  "## Style Guide",
  "",
  long("Style"),
  "## Session Core",
  "",
  long("Core"),
  "## TUI Theme Tokens",
  "",
  long("Theme"),
  "## Checks",
  "",
  "- Run the checks.",
  "",
].join("\n")

const areas: InstructionRouter.Area[] = [
  { name: "packages", path: "packages" },
  { name: "core", path: "packages/core" },
  { name: "tui", path: "packages/tui" },
]

describe("InstructionRouter", () => {
  test("sends area sections as index lines until the session works there", () => {
    const routed = InstructionRouter.route(file, { areas, texts: ["hello"], paths: ["c:/project"] })
    expect(routed).toContain("- Shared rule for everyone.")
    expect(routed).toContain("Style rule")
    expect(routed).toContain("- Run the checks.")
    expect(routed).not.toContain("Core rule")
    expect(routed).not.toContain("Theme rule")
    expect(routed).toContain("- Session Core → packages/core")
    expect(routed).toContain("- TUI Theme Tokens → packages/tui")
    expect(routed.length).toBeLessThan(file.length / 2)
  })

  test("loads a section once a tool call touches its area or the person names it", () => {
    const touched = InstructionRouter.route(file, {
      areas,
      texts: ["fix the bug"],
      paths: ['{"path":"c:/project/packages/core/src/session/runner.ts"}'],
    })
    expect(touched).toContain("Core rule")
    expect(touched).not.toContain("Theme rule")

    const named = InstructionRouter.route(file, { areas, texts: ["Почини TUI панель"], paths: [] })
    expect(named).toContain("Theme rule")
    expect(named).not.toContain("Core rule")

    const harness = InstructionRouter.route(file, { areas, texts: ["<shell-output>packages tui</shell-output>"], paths: [] })
    expect(harness).not.toContain("Theme rule")
  })

  test("keeps a file without area sections byte for byte", () => {
    const plain = ["# Rules", "", "## Commits", "", long("Commit")].join("\n")
    expect(InstructionRouter.route(plain, { areas, texts: [], paths: [] })).toBe(plain)
  })

  test("reads tool inputs and the session directory as touched paths", () => {
    const { paths, texts } = InstructionRouter.activity(
      [
        { type: "user", id: "msg_1", time: { created: 0 }, text: "go", files: [], agents: [] },
        {
          type: "assistant",
          id: "msg_2",
          time: { created: 0 },
          content: [
            {
              type: "tool",
              id: "call_1",
              name: "read",
              time: { created: 0 },
              state: { status: "completed", input: { path: "C:\\project\\packages\\tui\\src\\app.tsx" }, content: [] },
            },
          ],
        },
      ] as never,
      "C:\\project",
    )
    expect(texts).toEqual(["go"])
    expect(paths.some((item) => item.includes("packages/tui/"))).toBe(true)
    expect(InstructionRouter.route(file, { areas, texts, paths })).toContain("Theme rule")
  })

  test("finds areas one and two levels below the project root", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "instruction-router-"))
    try {
      await mkdir(path.join(root, "packages", "core", "src"), { recursive: true })
      await mkdir(path.join(root, "node_modules", "x"), { recursive: true })
      await mkdir(path.join(root, ".git"), { recursive: true })
      expect(InstructionRouter.areas(root)).toEqual([
        { name: "packages", path: "packages" },
        { name: "core", path: "packages/core" },
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("routes this repository's own AGENTS.md", async () => {
    const root = path.resolve(import.meta.dir, "../../..")
    const content = await Bun.file(path.join(root, "AGENTS.md")).text()
    const project = InstructionRouter.areas(root)
    const idle = InstructionRouter.route(content, { areas: project, texts: [], paths: [root.toLowerCase()] })
    expect(idle).toContain("## Style Guide")
    expect(idle).toContain("## Commits and PR Titles")
    expect(idle).not.toContain("Keep durable events minimal")
    expect(idle).toContain("- V2 Session Core → packages/core")
    const core = InstructionRouter.route(content, {
      areas: project,
      texts: [],
      paths: [`${root}/packages/core/src/session/runner/llm.ts`.replaceAll("\\", "/").toLowerCase()],
    })
    expect(core).toContain("Keep durable events minimal")
  })
})
