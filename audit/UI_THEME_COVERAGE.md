# UI Theme Coverage

How each TUI surface consumes the selected theme, and what verifies it.
"Theme-aware" means the surface resolves colors from the active theme's
semantic tokens/surfaces (via `useTheme()`/`useThemes()`), not from literals.

| Surface/component | Theme-aware | Tested | Notes |
|---|---|---|---|
| Sidebar | Yes | Indirect (app render suites) | Consumes theme context tokens. |
| Session list & header | Yes | Indirect | Token-driven; no literal surface colors found in the sweep. |
| Main transcript | Yes | Indirect | Text/muted/feedback tokens. |
| Composer / prompt | Yes | Indirect (prompt suites) | Uses `currentSyntax` from the theme provider + tokens. |
| Footer | Yes | mini/footer suites | Mini surface derives from the resolved theme (`mini/theme.ts`), black/white only as terminal-default fallback. |
| Dialogs (generic) | Yes | dialog-select / dialog suites | `DialogSelect` and `Dialog` resolve the `dialog` surface. |
| Command palette | Yes | command-palette tests (new category suite) | Rail + list + title all on the `dialog` surface; redesigned in this branch. |
| Settings (/settings) | Yes | dialog-config-categories tests | `dialog` surface + `CategoryRail`; unchanged by this branch. |
| Theme picker | Yes | theme-persistence dialog test (new) | Preview/commit semantics verified against a fake config host. |
| Terminal pane | Yes | terminal-pane-theme tests | Resolves syntax + surface from the active theme per mode. |
| Markdown | Yes | Via resolved theme (`markdown` tokens) | Token set is part of every built-in's resolution matrix test. |
| Syntax highlighting | Yes | theme suites (`generateSyntax` from resolved tokens) | Regenerated from the active theme's tokens on switch. |
| Diff viewer | Yes | diff-viewer suites | `diff` tokens from the resolved theme; added/removed are semantic by design. |
| Notifications / toasts | Yes | toast suites | Feedback tokens (`text.feedback`/`background.feedback` roles). |
| Hub badge | Yes | hub-badge tests | Resolves the Orchestra document tokens. |
| Sculk sprite / effects | Artwork palette | — | Deliberate brand artwork colors (documented in THEME_SYSTEM_AUDIT), not surface colors. |
| Audio wave / effects | Artwork palette | — | Named harmonic emerald/gold, prop-overridable. |
| Loading spinners | Mostly | — | Theme-driven frames; the Knight-Rider scanner keeps a default red trail unless a color is passed (documented). |
| Scrollbars / selection / focus | Yes | Via token resolution matrix | `scrollbar`, selection and focus states are theme tokens resolved for every built-in in the new registry matrix test. |
| Custom themes | Yes | theme.test.ts discovery + registry suites | Discovered from config dirs; name collisions with built-ins resolve in the custom theme's favor; malformed themes fall back to Orchestra with a named error, without rewriting the stored selection. |
| System theme | Yes | theme-mode tests | Generated from the probed terminal palette; mode follows lock/terminal. |

## Verification behind this matrix

- Registry matrix (new): every registered built-in theme parses and resolves
  in every declared mode with core semantic tokens present.
- V1 migration suite: every built-in V1 theme migrates in its supported modes.
- Persistence suite (new): preview/commit/cancel/ordering/failure/migration
  against the real provider and dialog.
- Palette suite (new + existing): category navigation, counts, dedupe,
  search, settings browsing, narrow layout.
- Sweep: hex/RGBA literal search across `packages/tui/src` — remaining
  literals are the documented artwork/fallback/scrim cases above.

Known pre-existing failures on clean main (unrelated resolver-value drift and
sandbox flakiness) are listed in THEME_SYSTEM_AUDIT.md and were not hidden:
they fail identically with and without this branch.
