# Command Palette Audit

Branch: `ui-theme-palette`. File redesigned: `packages/tui/src/component/command-palette.tsx`.

## Previous architecture

Ctrl+P was a single flat `DialogSelect`: every palette command (sorted by
canonical category) plus, appended at the end, every settings entry. Suggested
commands were duplicated — once under a synthetic "Suggested" category with
`suggested:`-prefixed values and once in their real position — so the same
command appeared twice whenever no filter was typed. Category names existed
only as group labels between rows; there was no way to browse one category,
and settings were reachable in practice only by typing their names.

The building blocks for category navigation already existed and were proven
in `/settings` (`DialogConfig`): `CategoryRail` (with counts and automatic
hiding below 100 terminal columns), canonical categories with legacy-alias
collapsing (`command-categories.ts`), and Tab/Shift+Tab category cycling via
`DialogSelect` bindings.

## Design

The palette now mirrors `DialogConfig`'s layout exactly: a horizontal box,
`CategoryRail` on the left, `DialogSelect` on the right, dialog size "large"
while open.

Rail entries, in order:

1. **All** — every command plus every setting entry (count = both).
2. **Suggested** — commands whose `suggested` flag resolves true.
3. **Command categories** — only categories that actually have visible
   commands, in canonical order (`commandCategoryRank`); legacy group
   spellings collapse first (`Git` → `VCS`); plugin-defined groups keep their
   own names and sort after the canonical list, alphabetically.
4. **Settings sections** — one entry per settings category, with stable ids
   `setting:<Category>`. When a settings section's name equals a command
   category present in the rail (e.g. "Agent"), its label is suffixed
   "· Settings" so the two entries never read as duplicates.

Counts are computed from the same filtered option lists the palette displays
(developer-mode filtering via `listedCommand`, `palette` flag, and the
palette's own command excluded), so they change correctly when commands are
registered dynamically, plugins load, or developer mode toggles.

## Behavior

- **Filtering**: the right list shows only the selected category's entries.
  Category labels ride on rows only in the All view (mirroring
  `DialogConfig`), avoiding a repeated label on every row inside one category.
- **Search**: `DialogSelect`'s fuzzy search narrows within the selected
  category; in All it covers everything. Searchable text covers title, id,
  description, category, keybind text, and — for settings — names and
  keywords. Clearing the search restores the category's full list. No entry
  is ever duplicated: Suggested is a view, not a copy.
- **Keyboard**: Up/Down and Enter are `DialogSelect`'s; Tab / Shift+Tab cycle
  categories (bindings in the dialog layer, same as `/settings`); Escape
  closes. Note: in the test harness, shift+tab must be sent as the raw CSI Z
  sequence real terminals emit — the keymap matches that form.
- **Responsive**: the shared `CategoryRail` hides itself under 100 columns;
  keyboard cycling and the title (active category + count) keep full
  navigation available in narrow terminals.
- **Execution**: unchanged. Command rows still call `command.run()` after
  `dialog.clear()`; setting rows `dialog.replace()` into `DialogConfig` with
  the setting preselected; nothing executes a setting as a command.
- **Theme**: the palette uses the `dialog` surface and theme tokens
  throughout (rail, title, footer hint) — no fixed colors; it follows the
  selected theme like every other dialog.

## Test coverage

`test/cli/tui/command-palette.test.tsx`:

- Existing test (search finds a setting globally and opens it) passes
  unchanged against the redesign, at 80 columns (narrow layout).
- New full-stack test at 120 columns: the rail lists All/Suggested/Session/
  Agent/VCS/General/Chat/Notifications/Developer with the All count at
  12 (4 commands + 8 settings); a suggested command appears exactly once in
  All; Tab cycles All → Suggested (only the suggested command) → Session
  (both session commands only) → Agent → VCS (the legacy "Git" group);
  Shift+Tab walks back; the first settings section (General) is browsable
  with no typing and contains no commands; Enter on a setting opens
  `DialogConfig` at that setting.

Category canonicalization and alias behavior remain covered by
`test/cli/tui/command-categories.test.ts`.

## Remaining limitations

- Search is intentionally scoped to the selected category (All = global).
  There is no separate "search everywhere" toggle beyond selecting All.
- The rail truncates long labels at its fixed width (e.g. "Agent · Settings"
  shows as "Agent · Setting" at width 20) — inherited `CategoryRail`
  behavior, same as `/settings`.
