# Integration window (idea #22)

Once per sprint, every piece lands in one scratch build and the full check
suite runs over it. Divergences are caught early, while they are cheap to
fix — not at the end, when everything drifted apart.

## Sprint rule

Run `script/integration-window.sh` once per sprint, before the sprint's
work is declared done. A failing window blocks the sprint: fix the conflict
or the failing check first, then run the window again. Whoever closes the
sprint runs it; the result (pass, or the failure with its scratch path)
goes into the sprint's closing note.

## What the script does

1. Creates a scratch worktree of `--target` (default: `main`).
2. Merges `--branch` (default: the current branch) into it.
3. Installs dependencies and runs `typecheck` + `test` per package,
   sequentially — never the root `bun run check`, which runs out of memory
   on small machines (see AI_ATLAS, "Verification playbook").
4. On success removes the scratch worktree; on failure it keeps it and
   prints its path, so the conflict or the failing check can be inspected.

Only committed work is merged: uncommitted changes in the calling checkout
are not part of the window (a warning is printed). The live checkout is
never touched, and nothing is pushed.

## Usage

```sh
script/integration-window.sh [--branch <name>] [--target <ref>]
  [--packages "core schema ..."] [--checks typecheck|test|both]
  [--keep] [--no-install]
```

- `--packages` (default: `core schema protocol server cli ai plugin`) —
  the packages the window checks. Narrow it for a focused run, e.g.
  `--packages "core schema" --checks test`.
- `--scratch-dir <dir>` — where the scratch worktree is created (default:
  `$HOME/.cache/orchestra-integration`; also settable with
  `ORCHESTRA_INTEGRATION_DIR`). `/tmp` is not used: it is a small tmpfs on
  some machines and a full install does not fit in it. The script refuses
  to start with less than ~2 GB free there.
- `--keep` — keep the scratch worktree even on success.
- `--no-install` — skip `bun install` (only when the scratch already has
  dependencies, e.g. a re-run on a kept worktree).

## On failure

- **Merge conflict**: the script aborts the merge, lists the conflicting
  files, and keeps the scratch worktree. Resolve the conflict on the branch
  (rebase it onto the target, or merge the target into it), commit, and run
  the window again.
- **Failing check**: the script prints which package and check failed
  (`core:typecheck`, `server:test`, …) and keeps the scratch worktree.
  Reproduce the failure inside it, fix it on the branch, and run the window
  again.
