import { expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdtemp, writeFile, readFile, link, rm, stat } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { ProjectFilesFormat } from "../src/project-files/format"

test("a hostile journal hardlink cannot append to or rotate the linked file", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "orchestra-journal-"))
  const victim = path.join(directory, "victim")
  const journal = path.join(directory, "journal.jsonl")
  try {
    await writeFile(victim, "unchanged")
    await link(victim, journal)
    await Effect.runPromise(ProjectFilesFormat.appendJsonl(journal, { private: "entry" }, { rotateAtBytes: 1 }))
    expect(await readFile(victim, "utf8")).toBe("unchanged")
    expect(await readFile(journal, "utf8")).toBe("unchanged")
    expect(await stat(journal + ".1").catch(() => undefined)).toBeUndefined()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("ordinary journal append and one-backup rotation remain supported", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "orchestra-journal-"))
  const journal = path.join(directory, "journal.jsonl")
  try {
    await Effect.runPromise(ProjectFilesFormat.appendJsonl(journal, { first: true }))
    await Effect.runPromise(ProjectFilesFormat.appendJsonl(journal, { second: true }, { rotateAtBytes: 1 }))
    expect(await readFile(journal + ".1", "utf8")).toBe('{"first":true}\n')
    expect(await readFile(journal, "utf8")).toBe('{"second":true}\n')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
