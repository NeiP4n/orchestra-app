export * as ProjectDirs from "./project-dirs.js"

import { existsSync } from "node:fs"
import path from "node:path"

export const PRIMARY_DIR = ".orchestra"
export const LEGACY_DIR = ".opencode"

export const DIRS = [PRIMARY_DIR, LEGACY_DIR] as const

/** Returns relative primary path: `.orchestra/<rel>` */
export function primary(rel: string): string {
  return path.posix.join(PRIMARY_DIR, rel.replace(/\\/g, "/"))
}

/** Returns relative legacy path: `.opencode/<rel>` */
export function legacy(rel: string): string {
  return path.posix.join(LEGACY_DIR, rel.replace(/\\/g, "/"))
}

/** Returns both relative candidates in precedence order: `[".orchestra/<rel>", ".opencode/<rel>"]` */
export function relativeCandidates(rel: string): readonly [string, string] {
  return [primary(rel), legacy(rel)]
}

/**
 * Resolves path for reading: checks `.orchestra/<rel>` first, falls back to `.opencode/<rel>`,
 * returning `.orchestra/<rel>` if neither exists.
 */
export function resolveRead(directory: string, rel: string): string {
  const primaryPath = path.join(directory, PRIMARY_DIR, rel)
  if (existsSync(primaryPath)) return primaryPath
  const legacyPath = path.join(directory, LEGACY_DIR, rel)
  if (existsSync(legacyPath)) return legacyPath
  return primaryPath
}

/** Resolves path for writing: always `.orchestra/<rel>` */
export function resolveWrite(directory: string, rel: string): string {
  return path.join(directory, PRIMARY_DIR, rel)
}

/** Returns absolute candidate paths in precedence order: `[.orchestra/<rel>, .opencode/<rel>]` */
export function candidates(directory: string, rel: string): readonly [string, string] {
  return [path.join(directory, PRIMARY_DIR, rel), path.join(directory, LEGACY_DIR, rel)]
}

/** Checks whether `.orchestra/<rel>` or `.opencode/<rel>` exists */
export function exists(directory: string, rel: string): boolean {
  return existsSync(path.join(directory, PRIMARY_DIR, rel)) || existsSync(path.join(directory, LEGACY_DIR, rel))
}
