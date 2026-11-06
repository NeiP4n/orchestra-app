export * as ProjectFilesDescriptorsData from "./descriptors-data.js"

import type { FileDescriptor } from "./registry.js"

/**
 * Data files (slice S2): boards, journals and logs.
 *
 * - `kanban.yaml` — kanban board snapshot (columns by task_state),
 *   no git (rewritten on every sync), source derived.
 * - `dod-history/` — dated snapshots of the DoD board, no git, source file.
 * - `errors.jsonl` — error journal (append log), no git, source db.
 * - `events.jsonl` — project events (append log), no git, source db.
 * - `usage.jsonl` — token usage per session/task (append log), no git, source db.
 * - `quarantine.jsonl` — autoloop quarantine mirror (seq, reason, at),
 *   no git, source db. A poisoned fact must never replay after a
 *   file-only restore.
 * (dod.yaml and zones.yaml are already registered in the core.)
 *
 * None of these is versioned: they are runtime data, regenerated from
 * the DoD and the journal. DoD and zones need no syncer — the files
 * already ARE their stores.
 */
export const DESCRIPTORS: ReadonlyArray<FileDescriptor> = [
  {
    rel: "kanban.yaml",
    base: "orchestra",
    dir: false,
    kind: "board",
    purpose: "Kanban board snapshot: DoD items grouped by task_state, with owner and zone",
    git: false,
    source: "derived",
  },
  {
    rel: "dod-history/",
    base: "orchestra",
    dir: true,
    kind: "history",
    purpose: "Dated DoD snapshots, one per change (kept 30)",
    git: false,
    source: "file",
  },
  {
    rel: "errors.jsonl",
    base: "orchestra",
    dir: false,
    kind: "log",
    purpose: "Error journal mirrored from the autoloop journal",
    git: false,
    source: "db",
  },
  {
    rel: "events.jsonl",
    base: "orchestra",
    dir: false,
    kind: "log",
    purpose: "Project events mirrored from the autoloop journal",
    git: false,
    source: "db",
  },
  {
    rel: "usage.jsonl",
    base: "orchestra",
    dir: false,
    kind: "log",
    purpose: "Token usage per run mirrored from the autoloop journal",
    git: false,
    source: "db",
  },
  {
    rel: "quarantine.jsonl",
    base: "orchestra",
    dir: false,
    kind: "quarantine",
    purpose: "Autoloop quarantine mirror: poisoned facts that must never replay",
    git: false,
    source: "db",
  },
]
