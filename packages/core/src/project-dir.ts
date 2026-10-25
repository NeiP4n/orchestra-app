export * as ProjectDir from "./project-dir.js"

import { existsSync } from "node:fs"
import path from "node:path"

export const PRIMARY = ".orchestra"
export const LEGACY = ".opencode"
export const DIRECTORIES = [PRIMARY, LEGACY] as const

/**
 * Returns candidate subpaths relative to project root (primary first, then legacy).
 */
export function relativeCandidates(subpath: string): readonly [string, string] {
  return [path.join(PRIMARY, subpath), path.join(LEGACY, subpath)]
}

/**
 * Resolves a file path for reading:
 * checks `.orchestra/<subpath>` first; if it does not exist, falls back to `.opencode/<subpath>`.
 * If neither exists, returns `.orchestra/<subpath>`.
 */
export function resolveRead(root: string, subpath: string): string {
  const primary = path.join(root, PRIMARY, subpath)
  if (existsSync(primary)) return primary
  const legacy = path.join(root, LEGACY, subpath)
  if (existsSync(legacy)) return legacy
  return primary
}

/**
 * Resolves a file path for writing:
 * - If `.orchestra/<subpath>` exists, writes there.
 * - If not, but `.opencode/<subpath>` exists, keeps writing to `.opencode/<subpath>`.
 * - If neither file exists, but `.opencode` directory exists and `.orchestra` does not, keeps writing to `.opencode/<subpath>`.
 * - Otherwise writes to `.orchestra/<subpath>`.
 */
export function resolveWrite(root: string, subpath: string): string {
  const primary = path.join(root, PRIMARY, subpath)
  if (existsSync(primary)) return primary

  const legacy = path.join(root, LEGACY, subpath)
  if (existsSync(legacy)) return legacy

  const primaryDir = path.join(root, PRIMARY)
  const legacyDir = path.join(root, LEGACY)
  if (existsSync(legacyDir) && !existsSync(primaryDir)) {
    return legacy
  }

  return primary
}

/**
 * Resolves a directory path for reading:
 * checks `.orchestra/<subpath>` first; if it does not exist, falls back to `.opencode/<subpath>`.
 * If neither exists, returns `.orchestra/<subpath>`.
 */
export function resolveDirRead(root: string, subpath: string = ""): string {
  const primary = subpath ? path.join(root, PRIMARY, subpath) : path.join(root, PRIMARY)
  if (existsSync(primary)) return primary
  const legacy = subpath ? path.join(root, LEGACY, subpath) : path.join(root, LEGACY)
  if (existsSync(legacy)) return legacy
  return primary
}

/**
 * Resolves a directory path for writing:
 * - If `.orchestra/<subpath>` exists, writes there.
 * - If not, but `.opencode/<subpath>` exists, writes to `.opencode/<subpath>`.
 * - If neither exists, but `.opencode` root exists and `.orchestra` does not, writes to `.opencode/<subpath>`.
 * - Otherwise writes to `.orchestra/<subpath>`.
 */
export function resolveDirWrite(root: string, subpath: string = ""): string {
  const primary = subpath ? path.join(root, PRIMARY, subpath) : path.join(root, PRIMARY)
  if (existsSync(primary)) return primary
  const legacy = subpath ? path.join(root, LEGACY, subpath) : path.join(root, LEGACY)
  if (existsSync(legacy)) return legacy

  const primaryRoot = path.join(root, PRIMARY)
  const legacyRoot = path.join(root, LEGACY)
  if (existsSync(legacyRoot) && !existsSync(primaryRoot)) {
    return legacy
  }
  return primary
}
