import path from "path"
import { readFileSync } from "node:fs"
import type { PromptInfo } from "../../prompt/history"
import { writeJsonAtomic } from "../../util/persistence"

// Holds one in-progress draft per tab across Prompt remounts. A draft is
// consumed on take: restoring it moves it out of the stash, so a stale copy
// never shadows newer input.
export type DraftEntry = { prompt: PromptInfo; cursor: number }

const byTab = new Map<string | undefined, DraftEntry>()

// The stash also lives in <state>/prompt-drafts.json, so a TUI that exits or
// crashes between tab switches hands the drafts back on the next start. The
// file is written atomically and debounced; before initDraftStash runs (tests,
// headless embedders) the stash is memory-only, as it always was.
let file: string | undefined
let timer: ReturnType<typeof setTimeout> | undefined
let writing: Promise<void> = Promise.resolve()

const FLUSH_DEBOUNCE_MS = 250

// Loads the persisted stash and enables flushing. Called by the Prompt
// component on mount with the TUI state directory. Re-initializing with the
// same directory is a no-op; a different directory reloads (tests do this).
export function initDraftStash(stateDir: string) {
  const target = path.join(stateDir, "prompt-drafts.json")
  if (file === target) return
  file = target
  byTab.clear()
  try {
    const raw = JSON.parse(readFileSync(target, "utf8")) as { drafts?: Record<string, DraftEntry> }
    for (const [key, entry] of Object.entries(raw.drafts ?? {})) {
      if (entry && typeof entry === "object" && typeof entry.prompt?.text === "string") {
        byTab.set(key === "" ? undefined : key, entry)
      }
    }
  } catch {
    // Missing or corrupt file: start empty; the next flush overwrites it.
  }
}

function scheduleFlush() {
  if (!file || timer) return
  timer = setTimeout(() => {
    timer = undefined
    void flushDraftStash()
  }, FLUSH_DEBOUNCE_MS)
  // Never hold the process open for an unwritten draft.
  timer.unref?.()
}

// Writes the current stash now, serialized behind any in-flight write. A
// failed flush is dropped silently: the in-memory stash is still authoritative
// for this run and the next change schedules another attempt.
export function flushDraftStash(): Promise<void> {
  if (!file) return writing
  const target = file
  const drafts: Record<string, DraftEntry> = {}
  for (const [key, entry] of byTab) drafts[key ?? ""] = entry
  writing = writing.then(() => writeJsonAtomic(target, { version: 1, drafts })).catch(() => undefined)
  return writing
}

export function takeDraft(sessionID: string | undefined) {
  const entry = byTab.get(sessionID)
  byTab.delete(sessionID)
  if (entry) scheduleFlush()
  return entry
}

export function saveDraft(sessionID: string | undefined, entry: DraftEntry) {
  byTab.set(sessionID, entry)
  scheduleFlush()
}
