export * as ProjectFilesDescriptorsState from "./descriptors-state.js"

import type { FileDescriptor } from "./registry.js"

/**
 * State files (slice S1): the human-facing project state.
 *
 * - `orchestra.json` — this project's config (model defaults, MCP config
 *   path), git, source file. In git because the team shares one project
 *   config, like `dod.yaml` and `zones.yaml` — but secrets never live
 *   here; credentials belong to the credential store, never to this file.
 * - `rules.yaml` — project rules (mirror of the KV rules store), git,
 *   source db. In git because team-shared rules are read by every
 *   session, like DoD; the KV store is the truth, the file is the mirror.
 * - `tasks.yaml` — task list (projection of the DoD leaves), git, source
 *   derived. In git so the team sees the same task list; regenerated
 *   from `dod.yaml`, never edited by hand.
 * - `decisions.yaml` — ADR index (number, title, status, file), git,
 *   source derived. In git with the records it indexes; regenerated
 *   from `decisions/`.
 * - `decisions/` — ADR records (`adr-NNNN.md`), git, source file. The
 *   directory IS the store; `decisions.yaml` is only its index.
 * - `society.yaml` — society composition (groups, roles, members), git,
 *   source db. In git because the society's shape is team-shared; the
 *   KV group store is the truth, the file is the mirror.
 * - `budget.yaml` — budget (tokens, USD limits), git, source db. In git
 *   because spend limits are team-shared and amounts are not secrets;
 *   the group record in KV is the truth, the file is the mirror.
 * - `briefing.md` — project briefing, git, source file. File-owned (no
 *   briefing store exists in the database); in git because the whole
 *   team reads the same briefing.
 * - `handoffs.md` — handoffs between agents (append log), no git, source
 *   file. Not in git: a running log, like notes — it grows with every
 *   stop and is history, not shared state.
 * - `lifecycle.json` — lifecycle (stage, transitions), no git, source
 *   file. File-owned: no project-lifecycle store exists in the database
 *   (session/location lifecycles are different things). Not in git: it
 *   is runtime state that changes with every phase move, like health.
 * (project.json and team-notes.md are already registered in the core.)
 */
export const DESCRIPTORS: ReadonlyArray<FileDescriptor> = [
  {
    rel: "orchestra.json",
    base: "orchestra",
    dir: false,
    kind: "config",
    purpose:
      "Project config: model defaults, MCP config path, team settings. Team-shared, in git — secrets never live here; credentials belong to the credential store",
    git: true,
    source: "file",
  },
  {
    rel: "rules.yaml",
    base: "orchestra",
    dir: false,
    kind: "rules",
    purpose: "Project rules: mirror of the KV rule store, all scopes. Team-shared like DoD, in git; the KV store is the truth, the file is the mirror",
    git: true,
    source: "db",
  },
  {
    rel: "tasks.yaml",
    base: "orchestra",
    dir: false,
    kind: "tasks",
    purpose: "Task list: read-only projection of the DoD leaves (task_id, owner, state, zone). Regenerated from dod.yaml on sync; never edited by hand",
    git: true,
    source: "derived",
  },
  {
    rel: "decisions.yaml",
    base: "orchestra",
    dir: false,
    kind: "decisions",
    purpose: "ADR index: id, title, status, file, decidedAt for every record in decisions/. Regenerated from decisions/ on sync",
    git: true,
    source: "derived",
  },
  {
    rel: "decisions/",
    base: "orchestra",
    dir: true,
    kind: "decisions",
    purpose: "ADR records (adr-NNNN.md): the decisions themselves. The directory IS the store; decisions.yaml is only its index",
    git: true,
    source: "file",
  },
  {
    rel: "society.yaml",
    base: "orchestra",
    dir: false,
    kind: "society",
    purpose: "Society composition: federation groups (name, projects, mode, supervisor, budget). Team-shared, in git; the KV group store is the truth",
    git: true,
    source: "db",
  },
  {
    rel: "budget.yaml",
    base: "orchestra",
    dir: false,
    kind: "budget",
    purpose: "Budgets: the USD spend limit of each federation group. Team-shared, in git; the group record in KV is the truth",
    git: true,
    source: "db",
  },
  {
    rel: "briefing.md",
    base: "orchestra",
    dir: false,
    kind: "briefing",
    purpose: "Project briefing: title, goal, status. File-owned; no database source. Team-shared, in git",
    git: true,
    source: "file",
  },
  {
    rel: "handoffs.md",
    base: "orchestra",
    dir: false,
    kind: "handoff",
    purpose: "Handoff log: one entry per agent handoff (session, reason, what works, next step). Append-only, file-owned; not in git — a running log, like notes",
    git: false,
    source: "file",
  },
  {
    rel: "lifecycle.json",
    base: "orchestra",
    dir: false,
    kind: "lifecycle",
    purpose: "Lifecycle state: phase, timestamps, milestones. File-owned — no project-lifecycle store exists in the database; not in git — runtime state",
    git: false,
    source: "file",
  },
]
