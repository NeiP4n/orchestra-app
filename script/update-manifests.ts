#!/usr/bin/env bun
// Refresh the static update host in update/ from releases.json: the CLI manifest for a
// channel plus the installer served at update/install (the curl upgrade path downloads it).
//   bun script/update-manifests.ts                  # latest channel
//   bun script/update-manifests.ts --channel beta   # beta channel
//   bun script/update-manifests.ts --dry-run        # print what would be written
// Run by the release workflow after publishing a GitHub Release; also safe to run by hand.
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { cliUpdateManifest, latestEntry, readRegistryFile } from "../packages/cli/src/services/release-registry"

const root = path.resolve(import.meta.dir, "..")
const args = process.argv.slice(2)
const dryRun = args.includes("--dry-run")
const flag = (name: string) => {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}
const channel = flag("--channel") ?? "latest"
if (channel !== "latest" && channel !== "beta") fail("--channel must be latest or beta")

const registry = readRegistryFile(path.join(root, "releases.json"))
if (!registry) fail("releases.json is missing or malformed")
const entry = latestEntry(registry, channel)
if (!entry) fail(`No ${channel} release in releases.json`)

const manifestPath = path.join(root, "update", channel, "cli", "npm")
const manifest = JSON.stringify(cliUpdateManifest(entry), null, 2) + "\n"
const installerSource = path.join(root, "installer", "get.sh")
const installerTarget = path.join(root, "update", "install")

if (dryRun) {
  console.log(`Would write ${path.relative(root, manifestPath)}: ${manifest.trim()}`)
  console.log(`Would refresh ${path.relative(root, installerTarget)} from installer/get.sh`)
  process.exit(0)
}
mkdirSync(path.dirname(manifestPath), { recursive: true })
writeFileSync(manifestPath, manifest)
copyFileSync(installerSource, installerTarget)
console.log(`Wrote ${path.relative(root, manifestPath)} (version ${entry.version})`)
console.log(`Refreshed ${path.relative(root, installerTarget)}`)

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}
