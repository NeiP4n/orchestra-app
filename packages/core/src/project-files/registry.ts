export * as ProjectFilesRegistry from "./registry.js"

import { ProjectFilesDescriptorsState } from "./descriptors-state.js"
import { ProjectFilesDescriptorsData } from "./descriptors-data.js"
import { ProjectFilesDescriptorsIntegrations } from "./descriptors-integrations.js"

/**
 * The registry of every known file in `.orchestra`: one descriptor per
 * file or directory, with its purpose, its git rule and where its truth
 * lives. The index, the health check and the gitignore split all read
 * this registry, so a file that is not registered is a file no agent can
 * discover — and a file whose git flag disagrees with `.gitignore` is a
 * defect the tests catch.
 *
 * Where truth lives (`source`):
 * - `file` — the file IS the store (DoD, zones, ADR, briefing, notes).
 * - `db` — the database/journal is the truth; the file is a mirror that
 *   is rewritten on sync and compared on health check (rules, society,
 *   budget, quarantine, usage, events, errors).
 * - `derived` — the file is generated from something else and rewritten
 *   on sync (kanban board from DoD, index, health, tasks from DoD).
 *
 * `base` is `orchestra` (inside `.orchestra/`, the default) or `project`
 * (the project directory itself, a sibling of `.orchestra/` — only the
 * native skill registry lives there today).
 */

export type FileSource = "file" | "db" | "derived"

export interface FileDescriptor {
  /** Path relative to `.orchestra/` (or to the project dir when base is `project`). */
  readonly rel: string
  readonly base: "orchestra" | "project"
  /** `true` for directories (`reports/`, `snapshots/`, ...). */
  readonly dir: boolean
  readonly kind: string
  /** One line for humans and for the index: what is in this file. */
  readonly purpose: string
  /** Versioned in git. Secrets are never in git; memory and notes are not either. */
  readonly git: boolean
  readonly source: FileSource
}

/**
 * Files owned by the core module itself: the index, the health report,
 * the snapshots, and the discovered-content directories whose contents
 * belong to other subsystems but must still be listed in the index.
 */
export const CORE_DESCRIPTORS: ReadonlyArray<FileDescriptor> = [
  {
    rel: "index.yaml",
    base: "orchestra",
    dir: false,
    kind: "index",
    purpose: "Manifest of .orchestra: every file, what it holds, when it changed",
    git: true,
    source: "derived",
  },
  {
    rel: "health.json",
    base: "orchestra",
    dir: false,
    kind: "health",
    purpose: "Health report: per-file status (ok/missing/corrupt/divergent) and overall status",
    git: false,
    source: "derived",
  },
  {
    rel: "project.json",
    base: "orchestra",
    dir: false,
    kind: "config",
    purpose: "Project binding: the permanent orchestra ID of this folder",
    git: true,
    source: "file",
  },
  {
    rel: "dod.yaml",
    base: "orchestra",
    dir: false,
    kind: "board",
    purpose: "DoD board: tasks, verification steps, statuses",
    git: true,
    source: "file",
  },
  {
    rel: "team-notes.md",
    base: "orchestra",
    dir: false,
    kind: "notes",
    purpose: "Team notes: durable facts the whole team shares",
    git: false,
    source: "file",
  },
  {
    rel: "zones.yaml",
    base: "orchestra",
    dir: false,
    kind: "zones",
    purpose: "Zone registry: who owns which zone, granted passes",
    git: true,
    source: "file",
  },
  {
    rel: "snapshots/",
    base: "orchestra",
    dir: true,
    kind: "snapshot",
    purpose: "Point-in-time copies of .orchestra for rollback",
    git: false,
    source: "file",
  },
  {
    rel: "reports/",
    base: "orchestra",
    dir: true,
    kind: "report",
    purpose: "Reports: worker outcomes and round reports, one file per report",
    git: false,
    source: "file",
  },
  {
    rel: "notes/",
    base: "orchestra",
    dir: true,
    kind: "notes",
    purpose: "Notes: free-form project notes (society plan, research notes)",
    git: false,
    source: "file",
  },
  {
    rel: "plots/",
    base: "orchestra",
    dir: true,
    kind: "plots",
    purpose: "Plots: charts and diagrams agents produced for the project",
    git: false,
    source: "file",
  },
  {
    rel: "command/",
    base: "orchestra",
    dir: true,
    kind: "command",
    purpose: "Commands: project custom commands",
    git: false,
    source: "file",
  },
  {
    rel: "playtest/",
    base: "orchestra",
    dir: true,
    kind: "playtest",
    purpose: "Playtest: recordings of desktop playtest sessions",
    git: false,
    source: "file",
  },
]

export const allDescriptors = (): ReadonlyArray<FileDescriptor> => [
  ...CORE_DESCRIPTORS,
  ...ProjectFilesDescriptorsState.DESCRIPTORS,
  ...ProjectFilesDescriptorsData.DESCRIPTORS,
  ...ProjectFilesDescriptorsIntegrations.DESCRIPTORS,
]

export const descriptorFor = (rel: string): FileDescriptor | undefined =>
  allDescriptors().find((descriptor) => descriptor.rel === rel)

/**
 * Descriptor for a file path: the exact descriptor when one exists,
 * otherwise the longest enclosing directory descriptor — a file inside
 * `notes/` is a note, a file inside `reports/` is a report. Files under
 * no registered directory stay unregistered (`undefined`) and the index
 * lists them as `unknown`, never hiding them.
 */
export const descriptorForPath = (rel: string): FileDescriptor | undefined => {
  const exact = descriptorFor(rel)
  if (exact !== undefined) return exact
  const enclosing = allDescriptors()
    .filter((descriptor) => descriptor.dir && rel.startsWith(descriptor.rel))
    .sort((a, b) => b.rel.length - a.rel.length)
  return enclosing[0]
}

/** Relative paths versioned in git, for the `.gitignore` split. Directories keep their trailing slash. */
export const gitTrackedRels = (): ReadonlyArray<string> =>
  allDescriptors()
    .filter((descriptor) => descriptor.git && descriptor.base === "orchestra")
    .map((descriptor) => descriptor.rel)

/**
 * `.gitignore` lines for the split: ignore everything in `.orchestra/`,
 * then re-include the versioned files. Directories need two lines — the
 * directory itself and its contents — because `.orchestra/*` only
 * matches direct children.
 */
export const gitignoreLines = (): ReadonlyArray<string> => {
  const lines: Array<string> = [".orchestra/*"]
  for (const rel of gitTrackedRels()) {
    lines.push(`!.orchestra/${rel}`)
    if (rel.endsWith("/")) lines.push(`!.orchestra/${rel}*`)
  }
  return lines
}

/** Every known relative path, for the index generator. */
export const knownRels = (): ReadonlyArray<string> => allDescriptors().map((descriptor) => descriptor.rel)
