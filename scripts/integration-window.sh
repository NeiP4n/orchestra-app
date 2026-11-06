#!/usr/bin/env bash
# Integration window (idea #22): once per sprint, every piece lands in one
# scratch build and the full check suite runs over it — divergences are caught
# early, while they are cheap to fix, not at the end when everything drifted.
#
# What it does:
#   1. Creates a scratch worktree of --target (default: main).
#   2. Merges --branch (default: the current branch) into it.
#   3. Installs dependencies and runs typecheck + tests per package,
#      sequentially (never the root `bun run check`: it runs out of memory
#      on small machines — see AI_ATLAS, "Verification playbook").
#   4. On success removes the scratch worktree; on failure it keeps it and
#      prints its path, so the conflict or the failing check can be inspected.
#
# The scratch worktree lives under $HOME/.cache/orchestra-integration by
# default (override with --scratch-dir or ORCHESTRA_INTEGRATION_DIR): /tmp
# is too small on machines where it is a small tmpfs, and a full install
# needs room. The script checks for ~2 GB free before it starts.
#
# Only committed work is merged: uncommitted changes in the calling checkout
# are not part of the window (a warning is printed). The live checkout is
# never touched, and nothing is pushed.
#
# Usage:
#   scripts/integration-window.sh [--branch <name>] [--target <ref>]
#     [--packages "core schema ..."] [--checks typecheck|test|both]
#     [--scratch-dir <dir>] [--keep] [--no-install]
#
# Sprint rule: run this once per sprint, before the sprint's work is declared
# done — see docs/integration-window.md. A failing window blocks the sprint:
# fix the conflict or the failing check first, then run the window again.

set -euo pipefail

BRANCH=""
TARGET="main"
PACKAGES="core schema protocol server cli ai plugin"
CHECKS="both"
KEEP=0
INSTALL=1
SCRATCH_PARENT="${ORCHESTRA_INTEGRATION_DIR:-$HOME/.cache/orchestra-integration}"

usage() {
  sed -n '2,/^$/p' "$0" | sed 's/^# \?//'
  echo "Usage: $0 [--branch <name>] [--target <ref>] [--packages \"core schema ...\"]"
  echo "          [--checks typecheck|test|both] [--scratch-dir <dir>] [--keep] [--no-install]"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --branch) BRANCH="$2"; shift 2 ;;
    --target) TARGET="$2"; shift 2 ;;
    --packages) PACKAGES="$2"; shift 2 ;;
    --checks) CHECKS="$2"; shift 2 ;;
    --scratch-dir) SCRATCH_PARENT="$2"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    --no-install) INSTALL=0; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

case "$CHECKS" in
  typecheck|test|both) ;;
  *) echo "--checks must be typecheck, test or both" >&2; exit 2 ;;
esac

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

if [ -z "$BRANCH" ]; then
  BRANCH="$(git branch --show-current)"
  if [ -z "$BRANCH" ]; then
    echo "Not on a branch (detached HEAD): pass --branch explicitly" >&2
    exit 2
  fi
fi

if ! git rev-parse --verify --quiet "$TARGET" >/dev/null; then
  echo "No such target ref: $TARGET" >&2
  exit 2
fi
if ! git rev-parse --verify --quiet "$BRANCH" >/dev/null; then
  echo "No such branch: $BRANCH" >&2
  exit 2
fi

if [ -n "$(git status --porcelain)" ]; then
  echo "WARNING: the checkout has uncommitted changes; only committed work on $BRANCH is merged." >&2
fi

mkdir -p "$SCRATCH_PARENT"
FREE_KB="$(df -k --output=avail "$SCRATCH_PARENT" | tail -1 | tr -d ' ')"
if [ "$FREE_KB" -lt 2097152 ]; then
  echo "Not enough free space in $SCRATCH_PARENT ($((FREE_KB / 1024)) MB; need ~2 GB for a scratch install)." >&2
  echo "Pass --scratch-dir <dir> on a roomier filesystem, or free space first." >&2
  exit 1
fi

SCRATCH="$(mktemp -d "$SCRATCH_PARENT/orchestra-integration-XXXXXX")"
echo "Integration window: $BRANCH -> $TARGET in $SCRATCH"

cleanup() {
  if [ "$KEEP" -eq 0 ]; then
    git worktree remove --force "$SCRATCH" 2>/dev/null || rm -rf "$SCRATCH"
  fi
}

git worktree add --detach --quiet "$SCRATCH" "$TARGET"
echo "--- merge $BRANCH into $TARGET"
if ! git -C "$SCRATCH" merge --no-ff --no-edit "$BRANCH" >/tmp/orchestra-integration-merge.log 2>&1; then
  echo "MERGE CONFLICT: $BRANCH does not merge cleanly into $TARGET." >&2
  echo "Conflicting files:" >&2
  git -C "$SCRATCH" diff --name-only --diff-filter=U 2>/dev/null >&2 || true
  git -C "$SCRATCH" merge --abort 2>/dev/null || true
  echo "Scratch worktree kept at $SCRATCH (see /tmp/orchestra-integration-merge.log)." >&2
  exit 1
fi

if [ "$INSTALL" -eq 1 ]; then
  echo "--- bun install"
  if ! (cd "$SCRATCH" && bun install --frozen-lockfile); then
    echo "bun install failed; scratch worktree kept at $SCRATCH for inspection." >&2
    exit 1
  fi
fi

FAILED=""
for pkg in $PACKAGES; do
  dir="$SCRATCH/packages/$pkg"
  [ -d "$dir" ] || { echo "--- $pkg: no such package, skipped"; continue; }
  if [ "$CHECKS" = "both" ] || [ "$CHECKS" = "typecheck" ]; then
    if grep -q '"typecheck"' "$dir/package.json"; then
      echo "--- $pkg: typecheck"
      (cd "$dir" && bun run typecheck) || FAILED="$FAILED $pkg:typecheck"
    else
      echo "--- $pkg: no typecheck script, skipped"
    fi
  fi
  if [ "$CHECKS" = "both" ] || [ "$CHECKS" = "test" ]; then
    if grep -q '"test"' "$dir/package.json"; then
      echo "--- $pkg: test"
      (cd "$dir" && bun run test) || FAILED="$FAILED $pkg:test"
    else
      echo "--- $pkg: no test script, skipped"
    fi
  fi
done

if [ -n "$FAILED" ]; then
  echo "INTEGRATION WINDOW FAILED:$FAILED" >&2
  echo "Scratch worktree kept at $SCRATCH for inspection." >&2
  exit 1
fi

echo "INTEGRATION WINDOW PASSED: $BRANCH merges into $TARGET, checks green."
cleanup
