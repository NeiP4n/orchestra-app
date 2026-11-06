#!/usr/bin/env bun
// Generate a CHANGELOG.md section from the conventional commits between two releases.
// (Replaces the old AI-generated UPCOMING_CHANGELOG.md flow, which fed the retired
// publish.yml pipeline: it needed a live model session and v2.* tags, neither of
// which exists for Orchestra releases anymore.)
//   bun script/changelog.ts 1.1.0                  # commits since the newest registry entry to HEAD
//   bun script/changelog.ts 1.1.0 --dry-run        # print the section, change nothing
//   bun script/changelog.ts 1.1.0 --notes "Intro." # intro paragraph under the heading
//   bun script/changelog.ts 1.1.0 --from <ref> --to <ref> --date 2026-11-07 --channel beta
import { $ } from "bun"
import { readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { changelogSection, prependChangelogSection } from "../packages/cli/src/services/release-notes"
import { latestEntry, readRegistryFile } from "../packages/cli/src/services/release-registry"

const root = path.resolve(import.meta.dir, "..")
const args = process.argv.slice(2)
const version = args.find((arg) => !arg.startsWith("--"))
const flag = (name: string) => {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}

if (!version || !/^\d+\.\d+\.\d+$/.test(version))
  fail("Usage: bun script/changelog.ts <major.minor.patch> [--dry-run] [--notes ...] [--from <ref>] [--to <ref>] [--date YYYY-MM-DD] [--channel latest|beta]")
const channel = flag("--channel") ?? "latest"
if (channel !== "latest" && channel !== "beta") fail("--channel must be latest or beta")
const date = flag("--date") ?? new Date().toISOString().slice(0, 10)
if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) fail("--date must be YYYY-MM-DD")

const registry = readRegistryFile(path.join(root, "releases.json"))
const previous = latestEntry(registry ?? [], channel) ?? latestEntry(registry ?? [])
const from =
  flag("--from") ?? previous?.commit ?? (await $`git rev-list --max-parents=0 HEAD`.quiet().text()).trim()
const to = flag("--to") ?? "HEAD"
if ((await $`git rev-parse --verify ${from}`.quiet().nothrow()).exitCode !== 0) fail(`Unknown ref: ${from}`)
const log = (await $`git log ${from}..${to} --format=%H%x00%s`.quiet().text()).trim()
const commits = log
  ? log
      .split("\n")
      .map((line) => {
        const tab = line.indexOf("\0")
        return { hash: line.slice(0, tab), subject: line.slice(tab + 1) }
      })
      .filter((commit) => commit.hash && commit.subject)
  : []
const section = changelogSection(version, date, commits, flag("--notes"))

if (args.includes("--dry-run")) {
  process.stdout.write(section)
  process.exit(0)
}

const changelogPath = path.join(root, "CHANGELOG.md")
let text: string
try {
  text = readFileSync(changelogPath, "utf8")
} catch {
  text = `# Changelog

All notable changes to Orchestra are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). A release is a commit
on \`main\` plus an entry in \`releases.json\` — no git tags, because tags cannot be
created through the snapshot-push flow that publishes this repository. A release
is two commits: the bump commit (version + this file) and the registry commit
that records the bump commit's SHA in \`releases.json\`.

`
}
writeFileSync(changelogPath, prependChangelogSection(text, section))
console.log(`Added CHANGELOG.md section for ${version} (${commits.length} commits since ${from.slice(0, 9)}).`)

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}
