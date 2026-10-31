// Which paths differ from HEAD, straight from git. `git status --porcelain -z` is the fastest honest
// answer (27 ms on a Windows checkout here) and it already knows about .gitignore, so node_modules and
// build output never enter a snapshot.

import { CheckpointError, type Change, type ChangeKind } from "./types.js"

export function readChanges(root: string): Change[] {
  const result = Bun.spawnSync({
    cmd: ["git", "-C", root, "status", "--porcelain", "-z", "--untracked-files=all"],
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  })
  if (result.exitCode !== 0) {
    const message = new TextDecoder().decode(result.stderr).trim()
    throw new CheckpointError("not-a-repository", `${root} is not a git repository: ${message || "git status failed"}`)
  }
  return parseStatus(new TextDecoder().decode(result.stdout)).filter((change) => !isCheckpointPath(change.path))
}

export function isRepository(root: string) {
  const result = Bun.spawnSync({
    cmd: ["git", "-C", root, "rev-parse", "--is-inside-work-tree"],
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  })
  return result.exitCode === 0 && new TextDecoder().decode(result.stdout).trim() === "true"
}

// One NUL-terminated record per path: `XY <path>`, and for a rename or copy the previous path follows as
// its own record. Status letters are the staged/unstaged pair, so either column can carry the change.
export function parseStatus(output: string): Change[] {
  const tokens = output.split("\0").filter((token) => token.length > 0)
  const changes: Change[] = []
  for (let index = 0; index < tokens.length; index++) {
    const record = tokens[index]!
    const status = record.slice(0, 2)
    const file = record.slice(3)
    const staged = status[0]!
    const worktree = status[1]!

    if (staged === "R" || staged === "C") {
      const from = tokens[index + 1]
      index++
      changes.push({ path: normalize(file), kind: "renamed", ...(from ? { from: normalize(from) } : {}) })
      continue
    }
    changes.push({ path: normalize(file), kind: kindOf(staged, worktree) })
  }
  return changes
}

/** The checkpoint's own folder must never be part of a snapshot, even in a project that does not ignore it. */
export function isCheckpointPath(file: string) {
  return file === ".orchestra" || file === ".orchestra/checkpoints" || file.startsWith(".orchestra/checkpoints/")
}

function kindOf(staged: string, worktree: string): ChangeKind {
  if (staged === "?" || worktree === "?") return "untracked"
  if (staged === "D" || worktree === "D") return "deleted"
  if (staged === "A" || worktree === "A") return "added"
  return "modified"
}

function normalize(file: string) {
  return file.replaceAll("\\", "/")
}
