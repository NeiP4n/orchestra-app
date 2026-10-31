#!/usr/bin/env bun
// Type-checks only the packages this working tree touched, so a review of a small change does not
// pay for the whole monorepo. Packages run in dependency layers: `tui` and `cli` build `core`, so
// `core` finishes before the layer that references it starts, and a shared tsbuildinfo is never
// written twice at once. Inside a layer the checks run in parallel.
//
// Usage: bun script/check.ts                  changed packages (all active ones when the tree is clean)
//        bun script/check.ts --all            schema, core, cli, tui, app
//        bun script/check.ts core server      the named packages
import path from "node:path"

const root = path.resolve(import.meta.dir, "..")
// The packages a change usually lands in; --all and a clean tree check them.
const active = ["schema", "core", "cli", "tui", "app"]
const args = process.argv.slice(2)

if (args.includes("--help") || args.includes("-h")) {
  console.log("usage: bun script/check.ts [--all] [package...]")
  process.exit(0)
}

const requested = args.filter((arg) => !arg.startsWith("-"))
const packages =
  requested.length > 0 ? requested : args.includes("--all") ? active : (await changedPackages()) ?? active
if (packages.length === 0) {
  console.log("check: nothing to typecheck")
  process.exit(0)
}

// Lower ranks finish first: schema and util have no workspace build step, core is referenced by
// most other packages, and everything else is free to run together.
const rank = (name: string) => (name === "schema" || name === "util" ? 0 : name === "core" ? 1 : 2)
const layers = Object.entries(Object.groupBy(packages, rank))
  .sort(([left], [right]) => Number(left) - Number(right))
  .map(([, layer]) => layer!)

const started = performance.now()
const failures: Result[] = []
for (const layer of layers) {
  const results = await Promise.all(layer.map(typecheck))
  results.filter((result) => !result.ok).forEach((result) => failures.push(result))
  if (failures.length > 0) break
}

failures.forEach(({ name, ms, output }) => {
  console.log(`${name}: typecheck FAILED (${seconds(ms)})`)
  output.split(/\r?\n/).slice(0, 100).forEach((line) => console.log(`  ${line}`))
  if (output.split(/\r?\n/).length > 100) console.log("  … output truncated")
})
console.log(
  failures.length === 0
    ? `check: ${packages.length} package(s) OK in ${seconds(performance.now() - started)}`
    : `check: ${failures.length} of ${packages.length} package(s) failed`,
)
process.exit(failures.length > 0 ? 1 : 0)

type Result = { name: string; ok: boolean; ms: number; output: string }

async function typecheck(name: string): Promise<Result> {
  const directory = path.join(root, "packages", name)
  const manifest = Bun.file(path.join(directory, "package.json"))
  if (!(await manifest.exists())) return { name, ok: false, ms: 0, output: `packages/${name}/package.json does not exist` }
  const scripts = ((await manifest.json()) as { scripts?: Record<string, string> }).scripts
  if (!scripts?.typecheck) {
    console.log(`${name}: no typecheck script, skipped`)
    return { name, ok: true, ms: 0, output: "" }
  }

  const started = performance.now()
  const proc = Bun.spawn(["bun", "run", "typecheck"], { cwd: directory, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, exit] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  const ms = performance.now() - started
  const output = `${stdout}${stderr}`.trim()
  if (exit === 0) console.log(`${name}: typecheck OK (${seconds(ms)})`)
  return { name, ok: exit === 0, ms, output }
}

// The packages with uncommitted changes, or undefined when no package changed: then there is
// nothing to narrow down and the caller falls back to every active package.
async function changedPackages() {
  const proc = Bun.spawn(["git", "status", "--porcelain"], { cwd: root, stdout: "pipe", stderr: "pipe" })
  const tracked = proc.stdout
  const status = await new Response(tracked).text()
  await proc.exited

  const names = new Set(
    status
      .split(/\r?\n/)
      .filter(Boolean)
      .flatMap((line) => line.slice(3).trim().split(" -> "))
      .flatMap((file) => {
        const match = /^packages\/([^/]+)\//.exec(file)
        return match ? [match[1]] : []
      }),
  )
  return names.size > 0 ? [...names].sort() : undefined
}

function seconds(ms: number) {
  return `${(ms / 1000).toFixed(1)}s`
}
