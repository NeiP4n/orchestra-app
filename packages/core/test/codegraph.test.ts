import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { extractFile } from "@orchestra/core/codegraph/extract"
import { open, writeMeta } from "@orchestra/core/codegraph/db"
import { indexProject, listFiles } from "@orchestra/core/codegraph/indexer"
import { explore, impact, search, status } from "@orchestra/core/codegraph/query"
import { clip, LIMIT, renderExplore, renderImpact, renderSearch } from "@orchestra/core/codegraph/render"
import { tokenize } from "@orchestra/core/codegraph/tokens"

const project = (files: Record<string, string>) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codegraph-"))
  for (const [file, content] of Object.entries(files)) {
    const absolute = path.join(root, file)
    fs.mkdirSync(path.dirname(absolute), { recursive: true })
    fs.writeFileSync(absolute, content)
  }
  return root
}

const chain = () =>
  project({
    "src/a.ts": 'import { beta } from "./b"\nexport function alpha() {\n  return beta()\n}\n',
    "src/b.ts": 'import { gamma } from "./c"\nexport function beta() {\n  return gamma()\n}\n',
    "src/c.ts": "export function gamma() {\n  return 1\n}\n",
  })

describe("codegraph lexer", () => {
  test("comments, strings and regex literals never become tokens", () => {
    const values = tokenize(
      ['const a = "f(x)" // g(y)', "/* h(z) */ const b = c()", "const pattern = /q\\(/g", "b()"].join("\n"),
    ).map((token) => token.value)

    expect(values).toContain("b")
    expect(values).toContain("c")
    expect(values).not.toContain("f")
    expect(values).not.toContain("g")
    expect(values).not.toContain("h")
    expect(values).not.toContain("q")
  })

  test("positions are one-based and survive multi-line input", () => {
    const tokens = tokenize("\n\n  const value = 1\n")
    expect(tokens[0]?.value).toBe("const")
    expect(tokens[0]?.line).toBe(3)
    expect(tokens[0]?.column).toBe(3)
    expect(tokens[1]?.value).toBe("value")
    expect(tokens[1]?.line).toBe(3)
    expect(tokens[1]?.column).toBe(9)
  })
})

describe("codegraph extract", () => {
  const source = [
    'import { helper } from "./helper"',
    'import type { Thing } from "./types"',
    "",
    "export interface Options {",
    "  readonly deep: boolean",
    "}",
    "",
    'export type Mode = "a" | "b"',
    "",
    "export class Runner {",
    "  constructor(private readonly name: string) {}",
    "  start(depth: number) {",
    "    return helper(this.name, depth)",
    "  }",
    "}",
    "",
    "export function createSociety(goal: string): string {",
    "  const runner = new Runner(goal)",
    "  return runner.start(1)",
    "}",
    "",
    "const local = (value: number) => value + 1",
    "export default local",
  ].join("\n")

  test("imports come from the runtime scanner", () => {
    const extracted = extractFile("src/main.ts", source)
    // The runtime scanner erases `import type`, so a type-only import is not a runtime edge.
    expect(extracted.imports.map((module) => module.specifier)).toEqual(["./helper"])
    expect(extracted.imports[0]?.line).toBe(1)
    expect(extracted.edges.filter((edge) => edge.kind === "import").map((edge) => edge.dst)).toEqual(["./helper"])
  })

  test("declarations carry kind, container, export flag and end line", () => {
    const symbols = extractFile("src/main.ts", source).symbols
    const named = (name: string) => symbols.find((symbol) => symbol.name === name)

    expect(named("Options")?.kind).toBe("interface")
    expect(named("Mode")?.kind).toBe("type")
    expect(named("Runner")?.kind).toBe("class")
    expect(named("Runner")?.exported).toBe(true)
    expect(named("start")?.kind).toBe("method")
    expect(named("start")?.container).toBe("Runner")
    expect(named("start")?.endLine).toBe(14)
    expect(named("createSociety")?.kind).toBe("function")
    expect(named("createSociety")?.line).toBe(17)
    expect(named("local")?.kind).toBe("function")
    expect(named("local")?.exported).toBe(false)
  })

  test("calls are attributed to the declaration that contains them", () => {
    const calls = extractFile("src/main.ts", source).edges.filter((edge) => edge.kind === "call")
    const from = (name: string) => calls.filter((edge) => edge.src.includes(`#${name}:`)).map((edge) => edge.dst)

    expect(from("createSociety")).toEqual(expect.arrayContaining(["Runner", "start"]))
    expect(from("Runner.start")).toContain("helper")
    expect(from("local")).toEqual([])
  })

  test("a call in a variable initializer belongs to the enclosing function", () => {
    const extracted = extractFile(
      "src/nested.ts",
      "export function outer() {\n  const inner = helper(1)\n  return inner\n}\n",
    )
    const calls = extracted.edges.filter((edge) => edge.kind === "call")
    expect(calls.length).toBe(1)
    expect(calls[0]?.src).toContain("#outer:")
  })

  test("object literal properties are declarations, plain data is not", () => {
    const society = [
      "export const Society = {",
      '  createSociety: Effect.fn("Society.createSociety")(function* (input) {',
      "    return helper(input)",
      "  }),",
      "  sent: Date.now(),",
      '  label: "society",',
      "  count: 3,",
      "}",
    ].join("\n")

    const extracted = extractFile("src/society.ts", society)
    const created = extracted.symbols.find((symbol) => symbol.name === "createSociety")
    expect(created?.kind).toBe("method")
    expect(created?.exported).toBe(false)

    const calls = extracted.edges.filter((edge) => edge.kind === "call" && edge.src.includes("#createSociety:"))
    expect(calls.map((edge) => edge.dst)).toContain("helper")
    expect(extracted.symbols.some((symbol) => symbol.name === "sent")).toBe(false)
    expect(extracted.symbols.some((symbol) => symbol.name === "label")).toBe(false)
    expect(extracted.symbols.some((symbol) => symbol.name === "count")).toBe(false)
  })
})

describe("codegraph index", () => {
  test("lists project files through git, and walks a plain folder", () => {
    const plain = project({ "src/a.ts": "export const a = 1\n", "node_modules/pkg/index.ts": "export const b = 2\n" })
    expect(listFiles(plain)).toContain("src/a.ts")
    expect(listFiles(plain)).not.toContain("node_modules/pkg/index.ts")

    Bun.spawnSync({ cmd: ["git", "init", "-q"], cwd: plain, stdout: "pipe", stderr: "pipe" })
    expect(listFiles(plain)).toContain("src/a.ts")
  })

  test("indexing stores symbols, then only re-reads what changed", () => {
    const root = project({
      "src/a.ts": 'import { beta } from "./b"\nexport function alpha() {\n  return beta()\n}\n',
      "src/b.ts": "export function beta() {\n  return 1\n}\n",
      "node_modules/pkg/index.ts": "export function ignored() {}\n",
    })

    expect(status(root).indexed).toBe(false)

    const first = indexProject(root)
    expect(first.files).toBe(2)
    expect(first.indexed).toBe(2)
    expect(first.symbols).toBe(2)
    expect(first.edges).toBeGreaterThanOrEqual(2)

    const second = indexProject(root)
    expect(second.indexed).toBe(0)
    expect(second.unchanged).toBe(2)

    fs.writeFileSync(path.join(root, "src", "b.ts"), "export function beta() {\n  return 2\n}\n")
    const third = indexProject(root)
    expect(third.indexed).toBe(1)
    expect(third.unchanged).toBe(1)

    fs.rmSync(path.join(root, "src", "a.ts"))
    const fourth = indexProject(root)
    expect(fourth.removed).toBe(1)
    expect(fourth.files).toBe(1)

    const now = status(root)
    expect(now.indexed).toBe(true)
    expect(now.symbols).toBe(1)
    expect(now.indexedAt).toBeGreaterThan(0)
  })

  test("the index directory is not part of the indexed files", () => {
    const root = project({ "src/a.ts": "export const a = 1\n" })
    indexProject(root)
    expect(fs.existsSync(path.join(root, ".orchestra", "codegraph.db"))).toBe(true)
    expect(indexProject(root).files).toBe(1)
  })

  test("a database written by an older extractor is rebuilt", () => {
    const root = project({ "src/a.ts": "export function a() {}\n" })
    indexProject(root)

    const graph = open(root)
    writeMeta(graph, "version", "1")
    graph.db.close()

    expect(indexProject(root).indexed).toBe(1)
    expect(indexProject(root).indexed).toBe(0)
  })

  test("a small project is indexed by the first query, a large one is not", () => {
    const small = project({ "src/a.ts": "export function smallProject() {}\n" })
    expect(search(small, "smallProject").map((hit) => hit.symbol.name)).toContain("smallProject")

    const files = Object.fromEntries(
      Array.from({ length: 401 }, (_, index) => [`src/f${index}.ts`, "export const value = 1\n"]),
    )
    const large = project(files)
    expect(search(large, "value")).toEqual([])
    expect(status(large).indexed).toBe(false)
  })
})

describe("codegraph query", () => {
  test("search ranks an exact name first and finds substrings", () => {
    const root = chain()
    indexProject(root)

    expect(search(root, "gamma")[0]?.symbol.name).toBe("gamma")
    expect(search(root, "gam").map((hit) => hit.symbol.name)).toContain("gamma")
    expect(search(root, "amm").map((hit) => hit.symbol.name)).toContain("gamma")
    expect(search(root, "nothing-like-this")).toEqual([])
  })

  test("explore answers declaration, callers, callees and importers at once", () => {
    const root = chain()
    indexProject(root)

    const beta = explore(root, "beta")
    expect(beta?.symbol.path).toBe("src/b.ts")
    expect(beta?.callers.map((caller) => caller.name)).toContain("alpha")
    expect(beta?.callees.map((callee) => callee.name)).toContain("gamma")
    expect(beta?.importers).toContain("src/a.ts")

    expect(explore(root, "unknown-symbol")).toBeUndefined()
  })

  test("impact walks callers ring by ring", () => {
    const root = chain()
    indexProject(root)

    const radius = impact(root, "gamma", 3)
    expect(radius?.target.name).toBe("gamma")
    expect(radius?.rings[0]?.depth).toBe(1)
    expect(radius?.rings[0]?.callers.map((caller) => caller.name)).toEqual(["beta"])
    expect(radius?.rings[1]?.callers.map((caller) => caller.name)).toEqual(["alpha"])
    expect(radius?.files).toEqual(expect.arrayContaining(["src/a.ts", "src/b.ts", "src/c.ts"]))
  })

  test("impact does not expand a name that many declarations share", () => {
    const root = project({
      "src/a.ts": "export function target() {}\nexport function dupe() {\n  return target()\n}\n",
      "src/b.ts": "export function dupe() {}\n",
      "src/c.ts": "export function dupe() {}\n",
      "src/d.ts": "export function dupe() {}\n",
    })
    indexProject(root)

    const radius = impact(root, "target", 3)
    expect(radius?.rings).toHaveLength(1)
    expect(radius?.rings[0]?.callers.map((caller) => caller.name)).toEqual(["dupe"])
    expect(radius?.ambiguous).toEqual(["dupe"])
  })

  test("a call outside every declaration is attributed to its file", () => {
    const root = project({ "src/f.ts": "export function target() {}\nschedule(target())\n" })
    indexProject(root)

    const callers = explore(root, "target")?.callers ?? []
    expect(callers.map((caller) => caller.kind)).toContain("module")
    expect(callers[0]?.name).toBe("src/f.ts")
  })

  test("a workspace import points at the file inside the package", () => {
    const root = project({
      "packages/core/src/federation.ts":
        'export const Society = {\n  createSociety: Effect.fn("Society.createSociety")(function* () {}),\n}\n',
      "packages/server/src/api.ts":
        'import { Society } from "@orchestra/core/federation"\nexport function handler() {\n  return Society\n}\n',
    })
    indexProject(root)

    expect(explore(root, "createSociety")?.importers).toEqual(["packages/server/src/api.ts"])
  })
})

describe("codegraph render", () => {
  test("answers stay inside the context budget", () => {
    const root = chain()
    indexProject(root)

    const exploreText = renderExplore(explore(root, "beta")!)
    const impactText = renderImpact(impact(root, "gamma", 3)!)
    const searchText = renderSearch("gam", search(root, "gam"))

    expect(exploreText.length).toBeLessThanOrEqual(LIMIT)
    expect(impactText.length).toBeLessThanOrEqual(LIMIT)
    expect(searchText.length).toBeLessThanOrEqual(LIMIT)
    expect(exploreText).toContain("src/b.ts:2")
    expect(clip("x".repeat(LIMIT * 3)).length).toBeLessThanOrEqual(LIMIT)
    expect(renderSearch("nothing", [])).toBe('No symbol matches "nothing".')
  })
})
