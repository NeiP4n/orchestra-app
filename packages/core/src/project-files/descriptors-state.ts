export * as ProjectFilesDescriptorsState from "./descriptors-state.js"

import type { FileDescriptor } from "./registry.js"

/**
 * State files (slice S1): the human-facing project state. Each descriptor
 * is filled in by the slice together with its read/write/sync/compare/
 * restore implementation in `files-state.ts`.
 *
 * - `orchestra.json` — this project's config (model defaults, MCP config
 *   path), git, source file.
 * - `rules.yaml` — project rules (mirror of the KV rules store), git, source db.
 * - `tasks.yaml` — task list (projection of the DoD leaves), git, source derived.
 * - `decisions.yaml` — ADR index (number, title, status, file), git, source derived.
 * - `decisions/` — ADR records (`adr-NNNN.md`), git, source file.
 * - `society.yaml` — society composition (groups, roles, members), git, source db.
 * - `budget.yaml` — budget (tokens, USD limits), git, source db.
 * - `briefing.md` — project briefing, git, source file.
 * - `handoffs.md` — handoffs between agents (append log), no git, source file.
 * - `lifecycle.json` — lifecycle (stage, transitions), no git, source db.
 * (project.json and team-notes.md are already registered in the core.)
 */
export const DESCRIPTORS: ReadonlyArray<FileDescriptor> = []
