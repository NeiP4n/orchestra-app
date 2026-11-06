export * as ProjectFilesDescriptorsData from "./descriptors-data.js"

import type { FileDescriptor } from "./registry.js"

/**
 * Data files (slice S2): boards, journals and logs. Each descriptor is
 * filled in by the slice together with its read/write/sync/compare/
 * restore implementation in `files-data.ts`.
 *
 * - `kanban.yaml` — kanban board snapshot (columns by task_state), git, source derived.
 * - `dod-history/` — dated snapshots of the DoD board, no git, source file.
 * - `errors.jsonl` — error journal (append log), no git, source db.
 * - `events.jsonl` — project events (append log), no git, source db.
 * - `usage.jsonl` — token usage per session/task (append log), no git, source db.
 * - `quarantine.jsonl` — autoloop quarantine mirror (seq, reason, at),
 *   no git, source db. A poisoned fact must never replay after a
 *   file-only restore.
 * (dod.yaml and zones.yaml are already registered in the core.)
 */
export const DESCRIPTORS: ReadonlyArray<FileDescriptor> = []
