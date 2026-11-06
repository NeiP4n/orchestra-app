#!/usr/bin/env bun
// Cut an Orchestra release locally: runs the bump flow (script/bump-version.ts),
// which commits twice on main — the bump commit (version + CHANGELOG) and the registry
// commit (the releases.json entry pointing at the bump commit's SHA). Nothing is
// pushed and no tag is created: pushes go through the snapshot flow, and the binaries
// plus the GitHub Release are produced by the release workflow afterwards.
//   bun run release:pp 1.2.0 [--channel beta] [--notes "..."]
// This file must keep existing: packages/cli/src/version.ts uses its presence as the
// source-install marker (ORCHESTRA_LOCAL).
import path from "node:path"

const root = path.resolve(import.meta.dir, "..")
const args = process.argv.slice(2)
const version = args.find((arg) => !arg.startsWith("--"))
const flag = (name: string) => {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}
if (!version || !/^\d+\.\d+\.\d+$/.test(version))
  fail("Usage: bun run release:pp <major.minor.patch> [--channel latest|beta] [--notes ...]")

const bump = ["bun", path.join(root, "script", "bump-version.ts"), version]
const channel = flag("--channel")
if (channel) bump.push("--channel", channel)
const notes = flag("--notes")
if (notes) bump.push("--notes", notes)

const proc = Bun.spawn(bump, { cwd: root, stdout: "inherit", stderr: "inherit" })
const code = await proc.exited
if (code !== 0) process.exit(code)

console.log("")
console.log("Next steps:")
console.log("  1. Push the two release commits through the normal snapshot flow.")
console.log("  2. Run the release workflow (Actions → release) with the same version")
console.log("     and channel — it builds the CLI binaries, creates the GitHub Release")
console.log("     and refreshes the static update manifests.")
console.log("  3. Optionally run the release-desktop workflow for the desktop installers.")

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}
