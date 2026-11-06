#!/bin/sh
# Release smoke checks that pass on an 8 GB machine (D2). The full clean-build
# (--smoke) needs a machine with 16 GB or more — its typecheck OOMs here — so this
# script is the 8 GB-friendly substitute the release workflow runs instead.
#   bun script/release-smoke.sh
# Run from the repository root (or anywhere: it cds to the root first).
# Exits non-zero on the first failure.
set -eu
cd "$(dirname "$0")/.."

step() { echo "==> $1"; }

step "1/5 release registry parses and CHANGELOG covers the current version"
VERSION="$(node -p "require('./package.json').version")"
bun -e 'const { readRegistryFile } = await import("./packages/cli/src/services/release-registry.ts"); const entries = readRegistryFile("releases.json"); if (!entries) { console.error("releases.json is missing or malformed"); process.exit(1) } console.log(`releases.json: ${entries.length} entries, newest ${entries[0].version}`)'
grep -q "^## \[$VERSION\]" CHANGELOG.md || { echo "CHANGELOG.md has no section for $VERSION" >&2; exit 1; }
echo "CHANGELOG.md covers $VERSION"

step "2/5 workflow and action YAML files parse"
python3 - <<'PY'
import glob, sys, yaml
files = sorted(glob.glob(".github/workflows/*.yml") + glob.glob(".github/workflows/*.yaml") + glob.glob(".github/actions/*/action.yml"))
if not files:
    sys.exit("no workflow files found")
for path in files:
    with open(path) as handle:
        yaml.safe_load(handle)
    print(f"  ok {path}")
print(f"{len(files)} workflow/action files parse")
PY

step "3/5 build the CLI for this platform"
bun packages/cli/script/build.ts --single

step "4/5 compiled service smoke test"
bun packages/cli/script/service-smoke.ts

step "5/5 dry runs: bump and update-manifests"
bun script/bump-version.ts --dry-run 9.9.9 > /dev/null
echo "bump-version --dry-run ok"
bun script/update-manifests.ts --dry-run

echo "Release smoke: all green."
