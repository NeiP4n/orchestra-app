import { afterEach, expect, test } from "bun:test"
import { randomInt } from "node:crypto"
import { mkdtemp, writeFile, readFile, link, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { normalizePromptContent, openEditor } from "../src/editor"

const editor = process.env.EDITOR
const visual = process.env.VISUAL

afterEach(() => {
  process.env.EDITOR = editor
  process.env.VISUAL = visual
})

test("rejects when the external editor cannot start", async () => {
  delete process.env.VISUAL
  process.env.EDITOR = "opencode-editor-that-does-not-exist"
  const renderer = {
    suspend() {},
    resume() {},
    requestRender() {},
    currentRenderBuffer: { clear() {} },
  }

  await expect(openEditor({ value: "original", renderer: renderer as never })).rejects.toThrow()
})

test("normalizes a single trailing editor newline for one-line prompts", () => {
  expect(normalizePromptContent("hello\n")).toBe("hello")
  expect(normalizePromptContent("hello\r\n")).toBe("hello")
})

test("preserves multiline prompts that end with a newline", () => {
  expect(normalizePromptContent("hello\nworld\n")).toBe("hello\nworld\n")
})

test("a pre-planted predictable temp hardlink cannot overwrite another file", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "orchestra-editor-regression-"))
  const victim = path.join(directory, "victim.txt")
  const stamp = 910000000000000 + randomInt(1000000)
  const planted = path.join(os.tmpdir(), `${stamp}.md`)
  const now = Date.now
  try {
    await writeFile(victim, "unchanged")
    await link(victim, planted)
    Date.now = () => stamp
    delete process.env.VISUAL
    process.env.EDITOR = "orchestra-editor-that-does-not-exist"
    const renderer = { suspend() {}, resume() {}, requestRender() {}, currentRenderBuffer: { clear() {} } }
    await expect(openEditor({ value: "new prompt", renderer: renderer as never })).rejects.toThrow()
    expect(await readFile(victim, "utf8")).toBe("unchanged")
    expect(await readFile(planted, "utf8")).toBe("unchanged")
  } finally {
    Date.now = now
    await rm(planted, { force: true })
    await rm(directory, { recursive: true, force: true })
  }
})
