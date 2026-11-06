export * as ProjectFilesPaths from "./paths.js"

import path from "node:path"
import { ProjectDirs } from "../project-dirs.js"

/**
 * Shared paths for the project state files. Every file in `.orchestra`
 * is addressed through `ProjectDirs` (primary `.orchestra/`, legacy
 * `.opencode/` fallback on read, always `.orchestra/` on write) — never
 * by a hand-built `.orchestra/...` string, so the legacy fallback stays
 * in one place.
 *
 * A descriptor with base `project` lives in the project directory
 * itself, a sibling of `.orchestra/` (only the native skill registry
 * today): those paths resolve against the project directory, with no
 * legacy fallback — there never was an `.opencode/` sibling.
 */

export const INDEX_FILE = "index.yaml"
export const HEALTH_FILE = "health.json"
export const ORCHESTRA_CONFIG_FILE = "orchestra.json"
export const SNAPSHOTS_DIR = "snapshots"
export const SNAPSHOT_MANIFEST = "snapshot.json"
export const REPORTS_DIR = "reports"
export const NOTES_DIR = "notes"
export const PLOTS_DIR = "plots"
export const COMMAND_DIR = "command"
export const PLAYTEST_DIR = "playtest"
export const DECISIONS_DIR = "decisions"

/** Absolute path of a project state file for writing. Base `project` resolves against the project directory. */
export const writePath = (directory: string, rel: string, base: "orchestra" | "project" = "orchestra"): string =>
  base === "project" ? path.join(directory, rel) : ProjectDirs.resolveWrite(directory, rel)

/** Absolute path of a project state file for reading (legacy fallback included for base `orchestra`). */
export const readPath = (directory: string, rel: string, base: "orchestra" | "project" = "orchestra"): string =>
  base === "project" ? path.join(directory, rel) : ProjectDirs.resolveRead(directory, rel)

/** Absolute path of the `.orchestra` directory itself. */
export const orchestraDir = (directory: string): string => ProjectDirs.resolveWrite(directory, "")
