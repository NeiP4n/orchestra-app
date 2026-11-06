# Rollback plan for <version>

Copy this file to `.orchestra/releases/<version>/rollback.md` at release
time and fill it in. The Target is the tag or commit of the previous good
release — the one this release replaces. Write it before the release goes
out, not when the release breaks: a rollback plan invented during a fire is
a guess, and this file is what `script/rollback.sh <version>` executes.

Target: <tag or commit of the previous good release, e.g. v0.9.0>
Released: <YYYY-MM-DD>
Commit: <the release commit sha>

## Why this target

<one line: what the previous release was known good for>

## Steps

1. Run `script/rollback.sh <version>` on the deployment checkout.
2. Rebuild (`bun install` if dependencies changed, then the build).
3. Restart the server.
4. Run the Verify steps below.

## Verify

- <the check that proves the rollback worked, e.g. `orchestra serve` answers /health>
- <a smoke test of the main user flow>
