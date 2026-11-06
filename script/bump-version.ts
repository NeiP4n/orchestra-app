#!/usr/bin/env bun
// Bump Orchestra's own version everywhere it is the shared product version.
//   bun script/bump-version.ts 1.1.0 [--channel beta] [--notes "..."] [--dry-run]
// Writes: root package.json + every workspace package.json whose version equals the
// old root version (packages with their own version, e.g. kernel 0.1.0, keep it),
// bun.lock (via bun install), CHANGELOG.md (new section from commits since the
// previous registry entry), releases.json (new entry). Then commits twice: the bump
// commit, and the registry commit that records the bump commit's SHA (the SHA is
// only known after the first commit, so the entry can never live inside the commit
// it describes). Never pushes: publishing goes through the normal snapshot flow.
import { $ } from "bun"
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import { changelogSection, prependChangelogSection } from "../packages/cli/src/services/release-notes"
import {
  compareVersions,
  entryForVersion,
  latestEntry,
  readRegistryFile,
  type ReleaseEntry,
} from "../packages/cli/src/services/release-registry"

const root = path.resolve(import.meta.dir, "..")
const args = process.argv.slice(2)
const version = args.find((arg) => !arg.startsWith("--"))
const flag = (name: string) => {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}
const dryRun = args.includes("--dry-run")

if (!version || !/^\d+\.\d+\.\d+$/.test(version))
  fail("Usage: bun script/bump-version.ts <major.minor.patch> [--channel latest|beta] [--notes ...] [--dry-run]")
const channel = flag("--channel") ?? "latest"
if (channel !== "latest" && channel !== "beta") fail("--channel must be latest or beta")
const date = new Date().toISOString().slice(0, 10)

const rootPkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { version?: unknown }
const oldVersion = rootPkg.version
if (typeof oldVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(oldVersion)) fail("Root package.json has no usable version")
if (compareVersions(version, oldVersion) <= 0) fail(`${version} must be newer than the current ${oldVersion}`)

const registryPath = path.join(root, "releases.json")
const registry = readRegistryFile(registryPath) ?? []
if (entryForVersion(registry, version)) fail(`${version} is already in releases.json`)
const previous = latestEntry(registry, channel) ?? latestEntry(registry)

if (!dryRun) {
  const branch = (await $`git branch --show-current`.quiet().text()).trim()
  if (branch !== "main") fail(`Releases are cut from main, not ${branch || "(detached HEAD)"}`)
  if ((await $`git status --porcelain --untracked-files=no`.quiet().text()).trim())
    fail("Commit or stash your changes first: a release is exactly the committed HEAD.")
}

const changed: string[] = []
for (const file of packageJsonFiles(root)) {
  const parsed = JSON.parse(readFileSync(file, "utf8")) as { version?: unknown }
  if (parsed.version !== oldVersion) continue
  changed.push(path.relative(root, file))
  if (!dryRun) writeFileSync(file, `${JSON.stringify({ ...parsed, version }, null, 2)}\n`)
}

const from = previous?.commit ?? (await $`git rev-list --max-parents=0 HEAD`.quiet().text()).trim()
const log = (await $`git log ${from}..HEAD --format=%H%x00%s`.quiet().text()).trim()
const commits = log
  ? log
      .split("\n")
      .map((line) => {
        const tab = line.indexOf("\0")
        return { hash: line.slice(0, tab), subject: line.slice(tab + 1) }
      })
      .filter((commit) => commit.hash && commit.subject)
  : []
const notes = flag("--notes") ?? `Orchestra ${version}.`
const section = changelogSection(version, date, commits, notes)

if (dryRun) {
  console.log(`Would bump ${oldVersion} -> ${version} in ${changed.length} package.json files:`)
  for (const file of changed) console.log(`  ${file}`)
  console.log(`Would prepend a CHANGELOG.md section (${commits.length} commits since ${from.slice(0, 9)}).`)
  console.log(`Would register ${version} (${channel}) in releases.json after the bump commit.`)
  console.log(section)
  process.exit(0)
}

await $`bun install`.quiet()
const lockChanged = (await $`git status --porcelain --untracked-files=no bun.lock`.quiet().text()).trim() !== ""
const changelogPath = path.join(root, "CHANGELOG.md")
writeFileSync(changelogPath, prependChangelogSection(readFileSync(changelogPath, "utf8"), section))
await $`git add ${[...changed, "CHANGELOG.md", ...(lockChanged ? ["bun.lock"] : [])]}`.quiet()
await $`git commit -q -m ${`chore(release): ${version}`}`.quiet()
const sha = (await $`git rev-parse HEAD`.quiet().text()).trim()
const entry: ReleaseEntry = { version, commit: sha, date, channel, notes }
const updated = [...registry, entry].toSorted((a, b) => compareVersions(b.version, a.version))
writeFileSync(registryPath, `${JSON.stringify({ releases: updated }, null, 2)}\n`)
await $`git add releases.json`.quiet()
await $`git commit -q -m ${`chore(release): register ${version}`}`.quiet()
console.log(`Released ${version} (${channel}) at ${sha.slice(0, 9)}.`)
console.log("Push through the normal snapshot flow, then run the release workflow for binaries.")

function packageJsonFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".git") continue
    const file = path.join(dir, name)
    if (!statSync(file).isDirectory()) {
      if (name === "package.json") out.push(file)
      continue
    }
    out.push(...packageJsonFiles(file))
  }
  return out
}

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}
