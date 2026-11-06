import { readFileSync } from "node:fs"

// The release registry: releases.json at the repository root.
// A release is a commit on main plus a registry entry — no git tags, because
// tags cannot be created through the snapshot-push flow that publishes this repo.
// A release is two commits: the bump commit (version + CHANGELOG) and the registry
// commit that records the bump commit's SHA here (the SHA is only known after the
// first commit, so the entry can never live inside the commit it describes).
export interface ReleaseEntry {
  readonly version: string
  readonly commit: string
  readonly date: string
  readonly channel: ReleaseChannel
  readonly notes: string
  readonly yanked?: boolean
}

export type ReleaseChannel = "latest" | "beta"

const versionPattern = /^\d+\.\d+\.\d+$/
const commitPattern = /^[0-9a-f]{40}$/
const datePattern = /^\d{4}-\d{2}-\d{2}$/

export function parseRegistry(input: unknown): ReleaseEntry[] | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined
  const releases = (input as { releases?: unknown }).releases
  if (!Array.isArray(releases)) return undefined
  const entries: ReleaseEntry[] = []
  for (const item of releases) {
    const entry = parseEntry(item)
    if (!entry) return undefined
    entries.push(entry)
  }
  if (new Set(entries.map((entry) => entry.version)).size !== entries.length) return undefined
  return entries
}

function parseEntry(input: unknown): ReleaseEntry | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined
  const entry = input as Record<string, unknown>
  if (typeof entry.version !== "string" || !versionPattern.test(entry.version)) return undefined
  if (typeof entry.commit !== "string" || !commitPattern.test(entry.commit)) return undefined
  if (typeof entry.date !== "string" || !datePattern.test(entry.date)) return undefined
  if (entry.channel !== "latest" && entry.channel !== "beta") return undefined
  if (typeof entry.notes !== "string" || !entry.notes.trim()) return undefined
  if (entry.yanked !== undefined && typeof entry.yanked !== "boolean") return undefined
  return {
    version: entry.version,
    commit: entry.commit,
    date: entry.date,
    channel: entry.channel,
    notes: entry.notes,
    ...(entry.yanked === true ? { yanked: true } : {}),
  }
}

export function compareVersions(a: string, b: string): number {
  const left = a.split(".").map(Number)
  const right = b.split(".").map(Number)
  for (let index = 0; index < 3; index++) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1
  }
  return 0
}

export function latestEntry(
  entries: readonly ReleaseEntry[],
  channel: ReleaseChannel = "latest",
): ReleaseEntry | undefined {
  return entries
    .filter((entry) => entry.channel === channel && entry.yanked !== true)
    .toSorted((a, b) => compareVersions(b.version, a.version))[0]
}

export function entryForVersion(
  entries: readonly ReleaseEntry[],
  version: string,
): ReleaseEntry | undefined {
  return entries.find((entry) => entry.version === version)
}

export function readRegistryFile(path: string): ReleaseEntry[] | undefined {
  try {
    return parseRegistry(JSON.parse(readFileSync(path, "utf8")))
  } catch {
    return undefined
  }
}

/** The update-service manifest for the CLI updater: version + the package to install. */
export function cliUpdateManifest(entry: ReleaseEntry): {
  readonly version: string
  readonly metadata: { readonly package: string }
} {
  return { version: entry.version, metadata: { package: "@orchestra/cli" } }
}
