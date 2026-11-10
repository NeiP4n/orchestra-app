import { expect, test } from "bun:test"
import { readFile, stat, rm } from "node:fs/promises"
import path from "node:path"
import { writeTranscriptExport } from "../src/util/transcript-export"

test("transcript exports use distinct private directories and exact content", async () => {
  const files = await Promise.all([
    writeTranscriptExport("private transcript\n", "markdown"),
    writeTranscriptExport('{"x":1}\n', "json"),
  ])
  try {
    expect(path.dirname(files[0])).not.toBe(path.dirname(files[1]))
    expect(await readFile(files[0], "utf8")).toBe("private transcript\n")
    expect(await readFile(files[1], "utf8")).toBe('{"x":1}\n')
    expect(path.basename(files[0])).toBe("session.md")
    expect(path.basename(files[1])).toBe("session.json")
    if (process.platform !== "win32")
      for (const file of files) {
        expect((await stat(file)).mode & 0o077).toBe(0)
        expect((await stat(path.dirname(file))).mode & 0o077).toBe(0)
      }
  } finally {
    await Promise.all(files.map((file) => rm(path.dirname(file), { recursive: true, force: true })))
  }
})
