# Release flow and rollback (idea #23)

## Release flow

1. Cut the release from `main`: bump the version (see `script/version.ts`;
   our own versioning starts at 1.0.0, not OpenCode's), tag it, and write
   the release notes (`script/release.ts` generates the review and the
   changelog draft).
2. **Before the release goes out, write its rollback plan**: copy
   `docs/rollback-template.md` to `.orchestra/releases/<version>/rollback.md`
   and fill in the Target — the tag or commit of the previous good release.
   The plan is written ahead, not invented during a fire.
3. Run the integration window (`script/integration-window.sh`, see
   `docs/integration-window.md`): the release must merge cleanly and pass
   checks before it ships.
4. Ship (deploy / publish) and run the release's own Verify steps.

The rollback record is project-local state under `.orchestra/releases/`
(ignored by git, like the rest of `.orchestra/`); the template lives in
`docs/rollback-template.md`.

## Rollback

When a release breaks, return to the previous good release in one step,
following the plan written for that release:

```sh
script/rollback.sh <version> [--dry-run] [--force] [--to <ref>]
```

What it does:

1. Reads `.orchestra/releases/<version>/rollback.md` and its `Target:` line.
2. Verifies the target exists in the repo; refuses when tracked files have
   uncommitted changes (unless `--force`) — a rollback must not silently
   discard them. Untracked files survive `git reset --hard`, so they do not
   block it.
3. Tags the current HEAD as `rollback/<version>-before-<sha>` (safety net),
   then `git reset --hard` to the target.
4. Prints the Verify steps from the record: rebuild, restart the server,
   run them.

`--dry-run` prints the plan without changing anything. `--to <ref>`
overrides the recorded target (and says so — a deviation from the written
plan is worth noticing).

Nothing is pushed: if the rolled-back checkout is a shared branch, push the
result only after the Verify steps pass, like any other release step.

## When there is no plan

`rollback.sh` refuses when `.orchestra/releases/<version>/rollback.md`
does not exist — that is the point: a release without a written rollback
plan cannot be rolled back in one step. Write the plan at release time;
for a release that shipped without one, pick the previous good tag by hand
and pass it with `--to` (and write the plan down afterwards, so the next
release has one).
