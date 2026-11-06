#!/usr/bin/env bash
# Rollback (idea #23): return to the previous good release in one step,
# following the plan written for that release — not invented during a fire.
#
# The plan lives in `.orchestra/releases/<version>/rollback.md` (copy
# `docs/rollback-template.md` at release time and fill in the Target:
# the tag or commit of the previous good release). This script reads that
# record, verifies the target exists, tags the current HEAD as a safety net,
# and resets the checkout to the target.
#
# Run it on the deployment checkout, not on a development branch with
# uncommitted work: `git reset --hard` discards uncommitted changes
# (refused unless --force). After the reset, rebuild and restart the server
# and run the Verify steps from the record.
#
# Usage:
#   scripts/rollback.sh <version> [--dry-run] [--force] [--to <ref>]
#   scripts/rollback.sh 1.0.0 --dry-run
#
# Nothing is pushed: if the rolled-back checkout is a shared branch, push
# the result only after the Verify steps pass, like any other release step.

set -euo pipefail

VERSION="${1:-}"
DRY_RUN=0
FORCE=0
OVERRIDE=""

case "$VERSION" in
  ""|-h|--help)
    sed -n '2,/^$/p' "$0" | sed 's/^# \?//'
    echo "Usage: $0 <version> [--dry-run] [--force] [--to <ref>]"
    exit "${VERSION:+2}"
    ;;
esac
shift

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --force) FORCE=1; shift ;;
    --to) OVERRIDE="$2"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"
RECORD=".orchestra/releases/$VERSION/rollback.md"

if [ ! -f "$RECORD" ]; then
  echo "No rollback plan for $VERSION: $RECORD does not exist." >&2
  echo "Copy docs/rollback-template.md there at release time." >&2
  exit 1
fi

TARGET="$(grep -m1 '^Target:' "$RECORD" | sed 's/^Target:[[:space:]]*//' | tr -d '\r')"
if [ -n "$OVERRIDE" ]; then
  echo "WARNING: --to $OVERRIDE overrides the recorded target ($TARGET)." >&2
  TARGET="$OVERRIDE"
fi
if [ -z "$TARGET" ]; then
  echo "$RECORD names no target: add a 'Target: <tag or commit>' line." >&2
  exit 1
fi
if ! TARGET_COMMIT="$(git rev-parse --verify --quiet "$TARGET^{commit}")"; then
  echo "Recorded target does not exist in this repo: $TARGET" >&2
  exit 1
fi

HEAD_COMMIT="$(git rev-parse HEAD)"
if [ "$HEAD_COMMIT" = "$TARGET_COMMIT" ]; then
  echo "Already at the rollback target $TARGET ($TARGET_COMMIT); nothing to do."
  exit 0
fi

if ! git diff --quiet || ! git diff --cached --quiet; then
  if [ "$FORCE" -eq 0 ]; then
    echo "Tracked files have uncommitted changes; rollback refuses to discard them (pass --force to override)." >&2
    exit 1
  fi
fi

echo "Rollback $VERSION:"
echo "  from: $(git rev-parse --short HEAD) $(git log -1 --format=%s)"
echo "  to:   $TARGET ($TARGET_COMMIT) $(git log -1 --format=%s "$TARGET_COMMIT")"
echo "  plan: $RECORD"

if [ "$DRY_RUN" -eq 1 ]; then
  echo "Dry run: nothing changed."
  exit 0
fi

TAG="rollback/$VERSION-before-$(git rev-parse --short HEAD)"
if git rev-parse --verify --quiet "refs/tags/$TAG" >/dev/null; then
  echo "Safety-net tag $TAG already exists; keeping it."
else
  git tag "$TAG"
  echo "Safety net: current HEAD tagged as $TAG"
fi

git reset --hard "$TARGET_COMMIT"
echo "Rolled back to $TARGET."
echo "Next: rebuild, restart the server, and run the Verify steps from $RECORD:"
awk '/^## Verify/{show=1; next} /^##/{show=0} show' "$RECORD"
