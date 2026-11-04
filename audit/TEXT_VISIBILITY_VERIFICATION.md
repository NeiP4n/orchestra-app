# Text Visibility Verification — black-on-black audit

Date: 2026-11-04. Base: `main` @ `9ffabbd`.

## State of the base

`main` already carried the readability system from the MCP-role and review
rounds: the theme resolver's `ensureReadable` floors in
`packages/theme/src/tui/resolve.ts` (primary text 4.5:1, subdued roles
3.5:1, never-disappear floor 3.0:1), the state-pair repair (state text
measured against its OWN state background — buttons, form fields, feedback
surfaces, diff line numbers), and the registry regression test
`packages/tui/test/theme-contrast.test.ts`, which resolves **every**
built-in theme in every declared mode through the production pipeline and
measures the real foreground/background token pairs.

## What was checked in this mission

The registry test's measured pairs cover the surfaces this mission touched
and the ones the mission brief names:

- main conversation and Markdown: `markdown.text`, `markdown.code` (on
  base and raised), `markdown.linkText` on the conversation background;
- inline code and code blocks: `markdown.code` pairs above;
- tool results and sidebar: text roles on `background.raised` — the right
  sidebar's actual surface, and the surface the new MCP panel renders on;
- dialogs: text on overlay/raised surfaces;
- disabled and selected states, error/warning/success feedback text: the
  state-pair and feedback-pair sets added by the review round;
- custom themes: the resolver repairs any theme document through the same
  floors, and the fallback path is exercised by the theme package suite.

The new sidebar MCP code uses only semantic tokens, per `AGENTS.md`:
`text.base` for names, `text.muted` for summaries, `text.feedback.*` for
outcome states (error/warning/success), on the sidebar's raised surface —
all pairs inside the registry test's measured set. No raw colors, no
borrowed tokens. Nothing in the new code renders text with a foreground
that bypasses the resolver floors.

## Result

No remaining black-on-black pair was found in the measured registry: the
floors hold for every built-in theme and mode, and the regression test
passes (see `FINAL_VERIFICATION.md` for the run). The known design limit
stands as before: themes with a fully transparent background cannot be
repaired by the resolver alone and are judged against the terminal's own
background, exactly as the test models it.

No resolver rewrite was needed or made: the instruction was to verify the
actual rendering paths and fix what remains, and what remained was
verification, not another contrast engine.
