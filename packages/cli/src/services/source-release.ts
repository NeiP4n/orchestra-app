export * as SourceRelease from "./source-release"

import { $ } from "bun"
import path from "node:path"
import { existsSync } from "node:fs"
import { parseReleaseVersion } from "./updater-action"
import { entryForVersion, latestEntry, parseRegistry, readRegistryFile } from "./release-registry"
import type { ReleaseChannel, ReleaseEntry } from "./release-registry"

/**
 * Source-checkout updates run the Bun shell, Bun.spawn and Bun.semver, so they
 * exist only where the build AND the runtime provide them. A node artifact
 * (artifact "cli-node") reports channel "local" too, and there this module's
 * `import { $ } from "bun"` resolves to a bundled shim that throws on call —
 * callers must check this first and refuse honestly instead.
 */
export const supported = (artifact: string, hasBunRuntime: boolean) => artifact !== "cli-node" && hasBunRuntime

/** Honest refusal for builds without the Bun source updater: no git/network advice. */
export const UNSUPPORTED_MESSAGE =
  "Source-checkout updates require the Bun source installation. This Node build cannot update a checkout; run the update from the source installation under Bun."

// Releases are recorded in releases.json on main — no git tags, because tags cannot be
// created through the snapshot-push flow that publishes this repo. A release entry points
// at its bump commit's SHA, so resolving a version means reading the registry, not a tag.
const DEFAULT_INSTALL_BRANCH = "main"
const checkout = path.resolve(import.meta.dir, "../../../..")
const DEPENDENCY_TIMEOUT_MS = 5 * 60 * 1000
const VALIDATION_TIMEOUT_MS = 2 * 60 * 1000

/** The registry channel this install follows: beta only when explicitly opted in. */
export function registryChannel(): ReleaseChannel {
  return process.env.ORCHESTRA_RELEASE_CHANNEL?.trim() === "beta" ? "beta" : "latest"
}

/** Read the registry from origin/main (narrow fetch of the main branch only). */
async function registryFromOrigin(root: string): Promise<ReleaseEntry[] | undefined> {
  await $`git -C ${root} fetch --quiet origin +refs/heads/main:refs/remotes/origin/main`.quiet()
  const show = await $`git -C ${root} show origin/main:releases.json`.quiet().nothrow()
  if (show.exitCode !== 0) return undefined
  try {
    return parseRegistry(JSON.parse(show.text()))
  } catch {
    return undefined
  }
}

/** The release this checkout is pinned to: the registry entry whose commit is HEAD. */
export async function current(root = checkout) {
  const branch = await $`git -C ${root} symbolic-ref -q HEAD`.quiet().nothrow()
  if (branch.exitCode === 0) return undefined
  const head = (await $`git -C ${root} rev-parse HEAD`.quiet().text()).trim()
  if (!head) return undefined
  const local = readRegistryFile(path.join(root, "releases.json"))
  const localMatch = local?.find((entry) => entry.commit === head)
  if (localMatch) return localMatch.version
  // The entry for a release is recorded in the registry commit that follows its bump
  // commit, so a checkout pinned to the bump commit itself never carries its own entry
  // locally — resolve it from origin/main instead. Offline, this is just "unknown".
  const remote = await registryFromOrigin(root).then(
    (entries) => entries,
    () => undefined,
  )
  return remote?.find((entry) => entry.commit === head)?.version
}

export async function detached(root = checkout) {
  return (await $`git -C ${root} symbolic-ref -q HEAD`.quiet().nothrow()).exitCode !== 0
}

export async function latest(root = checkout) {
  const entries = await registryFromOrigin(root)
  if (!entries) return undefined
  return latestEntry(entries, registryChannel())?.version
}

export async function apply(release: string, root = checkout) {
  const entries = await registryFromOrigin(root)
  const entry = entries ? entryForVersion(entries, release) : undefined
  if (parseReleaseVersion(release) && !entry) {
    throw new Error(`Release ${release} is not recorded in releases.json on origin/main`)
  }
  return keepingEdits(root, async () => {
    const previous = (await $`git -C ${root} rev-parse HEAD`.quiet().text()).trim()
    try {
      if (entry) {
        await $`git -C ${root} checkout --detach ${entry.commit}`.quiet()
      } else {
        await checkoutDevelopmentBranch(root)
      }
      await installDependencies(root)
      await validateServer(root)
    } catch (error) {
      await $`git -C ${root} reset --hard --quiet ${previous}`.quiet().nothrow()
      throw error
    }
  })
}

export type Kept = { readonly type: "restored" } | { readonly type: "stashed"; readonly files: readonly string[] }

/**
 * Preserve tracked source edits while updating, but never stash untracked runtime state.
 * .opencode/index, caches, leases, failed batches and similar files are intentionally
 * local runtime data and must survive an update in place rather than being replayed by
 * `git stash pop`. Replaying those files is what caused /upgrade to report a huge list of
 * conflicts after a successful update.
 */
export async function keepingEdits(root: string, move: () => Promise<void>): Promise<Kept | undefined> {
  const trackedChanges = (await $`git -C ${root} status --porcelain --untracked-files=no`.quiet().text()).trim()
  if (!trackedChanges) {
    await move()
    return undefined
  }

  const label = `opencode-pp update ${new Date().toISOString()}`
  await $`git -C ${root} stash push --message ${label}`.quiet()
  try {
    await move()
  } catch (error) {
    await $`git -C ${root} stash pop`.quiet().nothrow()
    throw error
  }

  if ((await $`git -C ${root} stash pop`.quiet().nothrow()).exitCode === 0) return { type: "restored" }

  const files = (await $`git -C ${root} stash show --name-only ${"stash@{0}"}`.quiet().nothrow().text())
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
  await $`git -C ${root} reset --hard --quiet`.quiet()
  return { type: "stashed", files }
}

export function newest(versions: readonly string[]) {
  return versions.toSorted((a, b) => Bun.semver.order(b, a))[0]
}

async function refreshTracking(root: string, target: string) {
  const slash = target.indexOf("/")
  if (slash <= 0) throw new Error(`Unsupported upstream reference: ${target}`)
  const remote = target.slice(0, slash)
  const branch = target.slice(slash + 1)
  const refspec = `+refs/heads/${branch}:refs/remotes/${target}`
  await $`git -C ${root} fetch --quiet ${remote} ${refspec}`.quiet()
}

/**
 * Resolve the source install's update branch. Explicit configuration wins; otherwise prefer
 * main (the fork's current default), falling back to lan-rooms for older remotes.
 */
export async function installBranch(root = checkout) {
  const configured = process.env.ORCHESTRA_PP_BRANCH?.trim()
  if (configured) return configured
  const result = await $`git -C ${root} ls-remote --heads origin main lan-rooms`.quiet().nothrow()
  const branches = new Set(
    result
      .text()
      .split("\n")
      .map((line) => line.split("\t")[1]?.replace("refs/heads/", ""))
      .filter((name): name is string => Boolean(name)),
  )
  if (branches.has("main")) return "main"
  if (branches.has("lan-rooms")) return "lan-rooms"
  return DEFAULT_INSTALL_BRANCH
}

async function checkoutDevelopmentBranch(root: string) {
  const target = `origin/${await installBranch(root)}`
  await refreshTracking(root, target)
  await $`git -C ${root} checkout --quiet --detach ${target}`.quiet()
}

export type Branch =
  | { readonly type: "behind"; readonly name: string; readonly behind: number }
  | { readonly type: "current" }
  | { readonly type: "diverged" }
  | { readonly type: "no-upstream" }

export async function branch(root = checkout): Promise<Branch | undefined> {
  const name = (await $`git -C ${root} symbolic-ref -q --short HEAD`.quiet().nothrow().text()).trim()
  if (!name) return undefined
  const upstream = await $`git -C ${root} rev-parse --abbrev-ref --symbolic-full-name @{u}`.quiet().nothrow()
  let target: string
  if (upstream.exitCode === 0) {
    target = upstream.text().trim()
    await refreshTracking(root, target)
  } else {
    target = `origin/${name}`
    const fetched = await refreshTracking(root, target).then(
      () => true,
      () => false,
    )
    if (!fetched) return { type: "no-upstream" }
  }
  const comparison = await $`git -C ${root} rev-list --left-right --count ${"HEAD..." + target}`.quiet().nothrow()
  if (comparison.exitCode !== 0) return { type: "no-upstream" }
  const [ahead, behind] = comparison.text().trim().split(/\s+/).map(Number)
  if (!Number.isFinite(ahead) || !Number.isFinite(behind)) return { type: "no-upstream" }
  if (!behind) return { type: "current" }
  if (ahead) return { type: "diverged" }
  return { type: "behind", name, behind }
}

export type Install =
  | { readonly type: "behind"; readonly branch: string; readonly behind: number }
  | { readonly type: "current" }
  | { readonly type: "ahead" }

export async function install(root = checkout): Promise<Install> {
  const branch = await installBranch(root)
  const refspec = `+refs/heads/${branch}:refs/remotes/origin/${branch}`
  await $`git -C ${root} fetch --quiet origin ${refspec}`.quiet()
  const [ahead, behind] = (
    await $`git -C ${root} rev-list --left-right --count ${"HEAD...origin/" + branch}`.quiet().text()
  )
    .trim()
    .split(/\s+/)
    .map(Number)
  if (ahead) return { type: "ahead" }
  if (!behind) return { type: "current" }
  return { type: "behind", branch, behind }
}

export async function follow(root = checkout) {
  return keepingEdits(root, async () => {
    const previous = (await $`git -C ${root} rev-parse HEAD`.quiet().text()).trim()
    try {
      await checkoutDevelopmentBranch(root)
      await installDependencies(root)
      await validateServer(root)
    } catch (error) {
      await $`git -C ${root} reset --hard --quiet ${previous}`.quiet().nothrow()
      throw error
    }
  })
}

async function runBun(args: string[], root: string, timeout: number) {
  // Avoid Bun shell Command.timeout(): it is missing in some packaged runtimes and
  // makes the updater fail before it can replace itself with a newer checkout.
  const child = Bun.spawn([process.execPath, ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    timeout,
    killSignal: "SIGTERM",
  })
  const stdoutPromise = new Response(child.stdout).text()
  const stderrPromise = new Response(child.stderr).text()
  const exitCode = await child.exited
  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise])
  return { stdout, stderr, exitCode }
}

async function installDependencies(root: string) {
  const result = await runBun(["install", "--frozen-lockfile"], root, DEPENDENCY_TIMEOUT_MS)
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim()
    throw new Error(detail || `Dependency installation failed with exit code ${result.exitCode}`)
  }
}

async function validateServer(root: string) {
  if (!existsSync(path.join(root, "packages", "server"))) return
  const result = await runBun(["--cwd", "packages/server", "run", "typecheck"], root, VALIDATION_TIMEOUT_MS)
  if (result.exitCode !== 0) {
    const detail =
      result.stderr.trim() || result.stdout.trim() || `Server typecheck exited with code ${result.exitCode}`
    throw new Error(`Orchestra update validation failed:\n${detail}`)
  }
}

export async function pull(root = checkout) {
  const previous = (await $`git -C ${root} rev-parse HEAD`.quiet().text()).trim()
  if (!previous) throw new Error("Cannot determine the current checkout revision")

  return keepingEdits(root, async () => {
    let moved = false
    try {
      const upstream = await $`git -C ${root} rev-parse --abbrev-ref --symbolic-full-name @{u}`.quiet().nothrow()
      if (upstream.exitCode === 0) {
        const target = upstream.text().trim()
        await refreshTracking(root, target)
        await $`git -C ${root} merge --ff-only @{u}`.quiet()
      } else {
        const name = (await $`git -C ${root} symbolic-ref -q --short HEAD`.quiet().nothrow().text()).trim()
        if (!name) throw new Error("Cannot update a detached checkout without a release version")
        const target = `origin/${name}`
        await refreshTracking(root, target)
        await $`git -C ${root} merge --ff-only ${target}`.quiet()
      }
      moved = true
      await installDependencies(root)
      await validateServer(root)
    } catch (error) {
      if (moved) await $`git -C ${root} reset --hard --quiet ${previous}`.quiet().nothrow()
      throw error
    }
  })
}
