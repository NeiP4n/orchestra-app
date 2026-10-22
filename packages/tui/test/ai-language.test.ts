import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { applyAiLanguage } from "../src/util/ai-language"

let directory = ""
const previous = process.env.ORCHESTRA_CONFIG_DIR

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "ai-language-"))
  process.env.ORCHESTRA_CONFIG_DIR = directory
})

afterEach(async () => {
  if (previous === undefined) delete process.env.ORCHESTRA_CONFIG_DIR
  else process.env.ORCHESTRA_CONFIG_DIR = previous
  await rm(directory, { recursive: true, force: true })
})

const file = () => path.join(directory, "AGENTS.md")

test("a language adds one marked block after the user's own instructions and auto takes it out", async () => {
  await writeFile(file(), "# Mine\n\nUse tabs.\n")
  await applyAiLanguage("ru")
  const russian = await readFile(file(), "utf8")
  expect(russian).toStartWith("# Mine\n\nUse tabs.")
  expect(russian).toContain("only in Russian")

  await applyAiLanguage("en")
  const english = await readFile(file(), "utf8")
  expect(english).toContain("only in English")
  expect(english).not.toContain("Russian")

  await applyAiLanguage("auto")
  expect(await readFile(file(), "utf8")).toBe("# Mine\n\nUse tabs.\n")
})

test("auto never creates or rewrites a file it did not mark", async () => {
  await applyAiLanguage("auto")
  expect(await Bun.file(file()).exists()).toBe(false)
  await writeFile(file(), "no trailing newline")
  await applyAiLanguage("auto")
  expect(await readFile(file(), "utf8")).toBe("no trailing newline")
})

test("a file that only held the block is removed again", async () => {
  await applyAiLanguage("en")
  expect(await Bun.file(file()).exists()).toBe(true)
  await applyAiLanguage("auto")
  expect(await Bun.file(file()).exists()).toBe(false)
})
