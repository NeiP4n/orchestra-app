import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { flushDraftStash, initDraftStash, saveDraft, takeDraft } from "../../src/component/prompt/draft-stash"
import { emptyPrompt } from "../../src/prompt/history"

// The Prompt component stashes an unsent draft in onCleanup and takes it back
// in onMount across route remounts, keyed by sessionID or undefined for home.

function draft(text: string, cursor = text.length) {
  return { prompt: { ...emptyPrompt(), text }, cursor }
}

describe("prompt draft stash", () => {
  test("tab-keyed drafts stay on the tab they were written in", () => {
    const two = draft("notes for session two")
    saveDraft("ses_two", two)

    // Switching to another tab or home finds nothing.
    expect(takeDraft("ses_one")).toBeUndefined()
    expect(takeDraft("home")).toBeUndefined()

    // Returning to the original tab restores exactly its draft, once.
    expect(takeDraft("ses_two")).toBe(two)
    expect(takeDraft("ses_two")).toBeUndefined()
  })

  test("each tab keeps its own draft, including home", () => {
    const one = draft("DRAFT-ONE")
    const home = draft("draft on home")
    saveDraft("ses_one", one)
    saveDraft(undefined, home)

    expect(takeDraft(undefined)).toBe(home)
    expect(takeDraft("ses_one")).toBe(one)
  })

  test("a newer draft for the same slot replaces the older one", () => {
    saveDraft("ses_a", draft("first"))
    const second = draft("second")
    saveDraft("ses_a", second)
    expect(takeDraft("ses_a")).toBe(second)
  })

  test("drafts persist to the state file and a taken draft leaves it", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "draft-stash-persist-"))
    initDraftStash(dir)

    saveDraft("ses_persist", draft("survives restart"))
    await flushDraftStash()
    const file = path.join(dir, "prompt-drafts.json")
    const written = JSON.parse(readFileSync(file, "utf8"))
    expect(written.drafts.ses_persist.prompt.text).toBe("survives restart")

    // Restoring the draft removes it from the file too, so a stale copy
    // never comes back after the next restart.
    expect(takeDraft("ses_persist")?.prompt.text).toBe("survives restart")
    await flushDraftStash()
    expect(JSON.parse(readFileSync(file, "utf8")).drafts.ses_persist).toBeUndefined()
  })

  test("a file written by a previous run loads on init", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "draft-stash-load-"))
    writeFileSync(
      path.join(dir, "prompt-drafts.json"),
      JSON.stringify({ version: 1, drafts: { ses_old: { prompt: { ...emptyPrompt(), text: "from before" }, cursor: 3 } } }),
    )

    initDraftStash(dir)

    const restored = takeDraft("ses_old")
    expect(restored?.prompt.text).toBe("from before")
    expect(restored?.cursor).toBe(3)
  })

  test("a corrupt state file starts empty instead of crashing", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "draft-stash-corrupt-"))
    writeFileSync(path.join(dir, "prompt-drafts.json"), "{not json at all")

    initDraftStash(dir)

    expect(takeDraft("ses_anything")).toBeUndefined()
  })
})
