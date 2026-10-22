import { describe, expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { Hub } from "@orchestra/core/hub/index"
import { HubTool } from "@orchestra/core/tool/plugin/hub"
import { tmpdir } from "./fixture/tmpdir"

const entry = (id: string) => Hub.all.find((item) => item.id === id)!

describe("a query written as a sentence", () => {
  test("finds the entries a literal phrase search missed", () => {
    const content = entry("search.content-portable")
    expect(HubTool.matches(content, "search content in files with regex")).toBe(true)
    expect(HubTool.matches(content, "recursive regex search")).toBe(true)
    expect(HubTool.matches(content, "docker container logs")).toBe(false)
    expect(HubTool.matches(content, "")).toBe(true)
    expect(HubTool.matches(content, "search", "git")).toBe(false)
  })
})

describe("search recipes that need no extra tools", () => {
  test("the tools that need rg and fd point to them", () => {
    for (const id of ["search.content", "search.content-files", "search.glob"]) {
      const fallback = entry(id).fallback
      expect(fallback).toBeDefined()
      expect(entry(fallback!).requires).toBeUndefined()
    }
  })

  test.skipIf(process.platform !== "win32")("PowerShell runs them and skips node_modules and .git", async () => {
    await using dir = await tmpdir()
    for (const file of ["src/a.ts", "node_modules/pkg/b.ts", ".git/c.ts"]) {
      await mkdir(path.dirname(path.join(dir.path, file)), { recursive: true })
      await Bun.write(path.join(dir.path, file), "const x = 1 // TODO fix\n")
    }
    const run = async (id: string, args: Record<string, string>) => {
      const rendered = Hub.prepare(entry(id), args, { backend: "pwsh" })
      const proc = Bun.spawn(["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", rendered.command], {
        stdout: "pipe",
        stderr: "pipe",
      })
      const out = await new Response(proc.stdout).text()
      expect(await proc.exited).toBe(0)
      return out
    }
    const lines = await run("search.content-portable", { pattern: "TODO", path: dir.path })
    expect(lines).toContain("a.ts:1:const x = 1 // TODO fix")
    expect(lines).not.toContain("node_modules")
    expect(lines).not.toContain("c.ts")
    const files = await run("search.content-files-portable", { pattern: "TODO", path: dir.path })
    expect(files.trim().split(/\r?\n/)).toHaveLength(1)
    const names = await run("search.glob-portable", { pattern: "*.ts", path: dir.path })
    expect(names).toContain("a.ts")
    expect(names).not.toContain("b.ts")
    expect(names).not.toContain("c.ts")
  })
})
