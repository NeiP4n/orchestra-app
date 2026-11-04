# UI Text Visibility — Invisible and Low-Contrast Text Repair

Branch commit: `edd95c8` (`fix(theme): readability floor for resolved text tokens`).
User-reported defect (dark TUI screenshots: secondary text and inline-code
labels rendered substantially dimmer than surrounding text). Treated as a
functional defect, not a preference.

## 1. Method

Contrast was **measured through the real rendering pipeline**, not eyeballed
from source: every registered theme (`allThemes()` → `parseTheme` →
`resolveThemeDocument`, V1 assets migrated exactly as production does) ×
both modes × 20 foreground/background token pairs that components actually
render (text.base/muted on background.base and raised surfaces,
markdown.text/code/codeBlock/linkText/blockQuote, syntax tokens,
feedback base/muted, diff text/lineNumber/hunkHeader).

## 2. Findings (before the fix)

**276 token pairs below 3.0:1.** Worst offenders:

| Case | Ratio |
|---|---|
| lucent-orng / light, text.base on background | 1.21 |
| dracula / light, markdown.code | 1.12 |
| matrix / light, feedback.warning | 1.01 |
| text.muted on raised surfaces, nearly all themes | 1.3–2.2 |
| orchestra (default) / light: text.muted | 2.96 (2.33–2.96 across its surfaces) |
| orchestra / light: markdown.blockQuote | 3.38 |
| orchestra / light: syntax.comment | 3.45 |
| orchestra / light: feedback.error.base | 3.99 |

Orchestra **dark** (the screenshot case) was healthy for base text
(text.muted 6.70) — the screenshot dimness comes from the same token family
on raised/dialog surfaces and in themes whose muted scale sits far lower;
the defect class is registry-wide, not one theme. Failure classes confirmed:
muted scale too dark for its surfaces, incorrect light-mode resolution of
dark-first palettes, syntax/markdown tokens authored below any readable
floor, feedback muted variants nearly invisible.

## 3. The fix — a readability floor at resolution time

`packages/theme/src/tui/resolve.ts`: `ensureReadable()` post-processes the
output of `resolveView` (so the dialog-surface view is repaired too), with
`luminance` / `contrast` / `lift` helpers:

| Tier | Floor | Tokens |
|---|---|---|
| Primary text | 4.5:1 (WCAG AA, normal text) | text.base, text.muted, markdown.text/code/codeBlock/linkText, syntax.punctuation, diff text vs its own backgrounds, feedback.*.base, action/formfield base states |
| Subdued text | 3.5:1 | markdown.blockQuote, syntax.comment, diff.hunkHeader |
| Never disappear | 3.0:1 | feedback.*.muted, remaining markdown/syntax tokens, diff.lineNumber, and text.base/muted re-checked against `background.raised.high` (the real overlay/menu/hover surface) |

Properties of `lift`:

- Blends the composited foreground toward the pole (black/white) that
  reaches the floor with the **smallest change** — sequential per-surface
  lifts otherwise fight (during development, zenburn/dark muted was dragged
  to near-black by far-pole overshoot before this rule).
- If a floor is unreachable on a surface, it returns the better pole rather
  than giving up.
- Translucent backgrounds are skipped (the composited surface is unknowable
  — see limitations).
- Token values are **replaced, never mutated**: hue-scale RGBA instances are
  shared across tokens.
- Themes already meeting every floor resolve **byte-identical** (verified:
  orchestra dark muted keeps its authored #6f9ea4). Visual hierarchy is
  preserved — muted stays visibly subdued; nothing is flattened to white.

Semantic-token discipline (per AGENTS.md) is untouched: no component
changed, no token was repurposed, no hardcoded color exceptions were added;
the repair lives in the resolver where every theme — built-in, migrated
V1, and custom user themes — passes through.

## 4. Result (after the fix)

**0 pairs below 3.0:1** across the registry (both modes), with the tier
floors above enforced by test. `background.raised.max` was checked and has
zero component usage (a scale endpoint, not a text surface) — excluded from
pairs deliberately.

## 5. Regression tests

- `packages/tui/test/theme-contrast.test.ts` (new): registry-wide, all
  themes × modes, asserts the tier floors; transparent-background themes
  are composited over the mode-default terminal background for the ≥3.0
  check. Passes, together with the existing theme suites (23/23 across
  theme-contrast + theme-orchestra + theme suites).
- Revived `packages/theme/test/theme.test.ts`: its fixture pointed at
  `assets/opencode.json`, removed in PR #36 — the suite was 0/5 broken on
  clean main; repointed to `assets/orchestra.json`, now 5/5.

## 6. Limitations and unresolved items

- **Transparent-background themes** (e.g. lucent-orng): the real surface is
  the user's terminal background, which the app cannot know. The resolver
  skips repair there by design; the test judges them against the mode
  default. A user running such a theme over an adversarial terminal
  background can still get low contrast — inherent to transparency, and
  documented rather than hidden.
- Terminal color-depth (256/24-bit quantization) can shift rendered colors
  slightly from the sRGB values measured here; floors carry margin (3.0
  minimum vs the 1.0–2.2 failures found).
- Verification is pipeline-level (resolved token values through the real
  resolver for every theme/mode/pair) plus the fixture-driven theme suites;
  it is not a screenshot capture of a live terminal — the sandbox must not
  run the TUI standalone (standing operator constraint), so no live-render
  claim is made.
