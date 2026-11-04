# Theme System Audit

Branch: `ui-theme-palette` (base: main 15d2efe). Scope: `packages/tui` theme
infrastructure (`src/theme`, `src/context/theme.tsx`), the theme picker dialog,
and theme consumers. Executed solo/sequentially per the repository owner's
standing instruction (no parallel-agent swarm).

## Previous architecture

Pipeline: theme JSON (built-in assets or `themes/*.json` in config directories)
→ `discoverThemes` → registry in `src/theme/index.ts` (`DEFAULT_THEMES` V1
assets, native V2 `orchestra`/`sculk`, generated `system`, custom files last so
they win name collisions) → `parseTheme` (V1 documents migrate via
`@orchestra/theme` `migrateV1`, V2 documents parse directly, results cached)
→ `resolveThemeDocument` per mode → `ThemeProvider` (`src/context/theme.tsx`)
exposes a `ComponentTheme` whose surfaces (`surface("dialog")`, …) components
consume via `useTheme()`/`useThemes()`. Mode handling: config pin
(`theme.mode` dark/light) or terminal-reported mode, with a generated
`system` theme built from the probed terminal palette.

The token architecture itself is sound: 107 of 196 tsx files consume the theme
context, and dialogs (`DialogSelect`, `DialogConfig`, `CategoryRail`) resolve
the `dialog` surface from the active theme. The defects were in registration,
persistence semantics, and the picker — not in token plumbing.

## Problems found

1. **The removed product's theme was registered twice.** `DEFAULT_THEMES`
   contained a V1 `opencode` asset, and `listThemes()` additionally inserted
   `opencode: getOpenCodeTheme()` — an alias of the Orchestra document that
   silently overrode the V1 entry. The picker offered "opencode" as a
   selectable built-in.
2. **No legacy migration.** A stored `theme.name = "opencode"` only worked
   because of that alias. Removing the alias without a migration would leave
   the config pointing at a nonexistent theme forever (the provider falls back
   in memory but never repairs the stored value).
3. **Persistence was fire-and-forget with swallowed errors.** `themes.set()`
   (and the mode `pin`/`free` writes) called `configState.update(...).catch(() => {})`:
   a failed write was indistinguishable from success, and nothing ordered
   competing writes.
4. **The picker wrote config while browsing.** `DialogThemeList` called
   `themes.set()` on every `onMove` and on filter changes, and called it again
   with the initial theme on cancel — scrolling the list produced a stream of
   config writes, and cancelling produced one more.
5. **A stored selection for a deleted theme was never repaired** (same root as
   #2 for arbitrary names).
6. **Stale test expectations.** The invalid-theme fallback tests expected the
   fallback selection to be named `"opencode"` while the provider has fallen
   back to the Orchestra document all along; they failed on clean main.

## Changes

- `src/theme/v1.ts`: `opencode` import and `DEFAULT_THEMES` entry removed;
  `src/theme/assets/opencode.json` deleted. The orphaned
  `src/theme/assets/v2/opencode.json` (no importer) deleted.
- `src/theme/index.ts`: `getOpenCodeTheme` alias and the `opencode:` insertion
  in `listThemes()` removed. Added `LEGACY_THEME_NAMES` ({ opencode:
  "orchestra" }) and `legacyThemeMigration(name)`. Custom themes keep priority:
  a user file named `opencode.json` still registers and is never migrated.
- `src/context/theme.tsx`:
  - All config writes now go through one serialized queue (`persistConfig`):
    writes apply in call order, a later confirmed selection can never be
    overwritten by an earlier write landing late, and failures reject to the
    caller. `set()`/`pin`/`free` route write failures to the existing
    theme-error channel (surfaced as a toast by `theme-error-toast`) instead of
    swallowing them.
  - New explicit semantics: `preview(theme)` switches the visible theme with
    no write; `commit(theme)` switches and resolves only after the write
    lands, rejecting on failure.
  - `repairStoredSelection()` runs after theme discovery completes: a stored
    name no discovered theme provides is migrated (legacy name) or repaired
    to `orchestra`, and the repair is persisted. Running after discovery means
    a custom theme that has not loaded yet is never mistaken for missing. A
    theme that exists but fails to parse is deliberately NOT rewritten (its
    owner may be mid-edit); the load error is reported via `themeErrors` and
    the session falls back to Orchestra in memory.
- `src/component/dialog-theme-list.tsx`: navigation and filtering call
  `preview()` only; cancel restores the initial theme in memory with zero
  writes; select calls `commit()`, shows a saving state (`loading`), closes
  only after the write succeeds, and surfaces failures with `toast.error`
  while staying open.
- Tests that used the deleted asset/alias as a generic fixture now use the
  Dracula V1 asset / `getOrchestraTheme()`; the stale fallback expectations
  were corrected to `"orchestra"` (the three tests pass again).

## Hardcoded color findings

Sweep of `packages/tui/src` for hex/RGBA literals outside theme assets found
**no accidental surface colors in interactive components**: dialogs, lists,
rails, prompts and panels consume resolved tokens/surfaces. The remaining
literals are deliberate and documented here rather than rewritten:

- `component/sculk-effects.tsx`, `component/audio-effects.tsx`,
  `component/audio-wave.tsx`: named artwork/data-visualization palettes
  (Sculk identity, harmonic emerald/gold), overridable via props.
- `ui/spinner.ts` (`createFrames`): the Knight-Rider scanner's default red
  trail; callers pass `options.color` to theme it.
- `component/reconnecting.tsx`, `component/session-frame.tsx`: translucent
  black scrims (`RGBA(0,0,0,α)`) — theme-independent dimming by design.
- `theme/color.ts`: the ANSI-16 fallback palette (infrastructure fallback).
- `mini/theme.ts`: black/white terminal default foreground/background
  fallback for the mini surface.
- `context/local.tsx`: agent colors come from user config data, not code.

## Persistence design (summary)

One source of truth (the existing config file via `ConfigProvider.update`,
whose promise resolves after the host write). Preview ≠ commit. Writes are
serialized through a per-provider promise queue. Commit resolves after the
host confirms; errors reach the user (dialog toast / theme-error toast).
Restart persistence is therefore just "the stored value is the last committed
value", verified by tests against a fake config host that applies drafts
exactly like the real one.

## Verification

- New `test/cli/tui/theme-persistence.test.tsx` (6 tests): preview writes
  nothing; commit persists before resolving; rapid commits land in order with
  the last selection stored; a failing write rejects and leaves the stored
  value untouched; a stored `opencode` migrates to `orchestra` and the
  migration is persisted; the real dialog flow — preview and cancel produce
  zero writes, select produces exactly one.
- `test/theme.test.ts`: registry test now asserts `orchestra` is the native
  V2 theme, `opencode` is absent, and `legacyThemeMigration` maps it; a new
  matrix test iterates **every** registered built-in: parse + resolve in every
  declared mode, with core tokens (text/background/border/muted) present.
  `test/theme/v2/v1-migrate.test.ts` separately migrates every built-in V1
  theme in its supported modes.
- TUI typecheck: 11 errors, identical to the clean-main baseline (all in
  `tool/plugin/{dream-team,muse-chat,orchestra}`).

## Remaining limitations

- Pre-existing failures on clean main, unrelated to this change and left
  untouched: seven V2-resolver expectation tests in `test/theme/v2/`
  (resolve/component suites, resolved-value drift), `dialog surfaces are
  absolute…` (resolved RGBA drift), and the sandbox-flaky mini/footer
  "startup stays editable…" family. They fail identically before and after
  this branch.
- Representative screenshot verification was not executed in the sandbox
  (no live terminal session); render-level coverage is via the test suites
  above, including full-stack dialog renders.
- Mode (`dark`/`light`/`system`) writes share the serialized queue and error
  channel, but mode has no preview/commit dialog flow; its callers are
  commands, so failures surface via the theme-error toast only.
