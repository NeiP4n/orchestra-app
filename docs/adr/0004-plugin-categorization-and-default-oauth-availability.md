# ADR 0004: Plugin Categorization UX & Out-of-the-Box Antigravity OAuth Availability

## Status
Accepted

## Context
1. **User Experience & Plugin Discovery**:
   Previously, plugins were displayed in a flat, unorganized structure or split only by binary runtime (`TUI` vs `Server`). As the plugin ecosystem grew to encompass identity, providers, browser tooling, code forges, skills, and system hooks, users and developers needed clear, domain-based categorization.
2. **Fresh Installation & Multi-User OAuth Discovery**:
   When users cloned the repository fresh on another machine (or for team/friend collaboration), `opencode-antigravity-auth` was not active out-of-the-box unless manually configured in local `orchestra.jsonc`. Consequently:
   - Antigravity was missing from the TUI and CLI plugin listings.
   - Google OAuth (`Google OAuth (Antigravity)`) was missing from `orchestra auth login` and interactive session logins.

## Decision
1. **Canonical Plugin Taxonomy**:
   Introduced canonical plugin categorization in `@orchestra/plugin/category` (Layer 3), exposing:
   - `Auth & Identity`: `opencode-antigravity-auth`, `opencode-claude-auth`, `orchestra.identity`, credentials, OAuth integrations.
   - `Providers & Models`: `opencode.provider.*`, `models-dev`, `zen-models`, `openai`, `azure`, `freebuff`, `modal`, etc.
   - `Tools & Automation`: `browser`, `desktop`, `playtest`, `mcp-forge`, `team-forge`, `command-forge`, `plugin-forge`, `patch`, `websearch`, etc.
   - `Skills & Knowledge`: `skill`, `skill-catalog`, `skill-marketplace`, `idea-bank`, `research`, `memory`, `note`, `symbols`.
   - `UI & Rendering`: `tui`, `merman` (Mermaid), `latex`, `theme`, `formatter`.
   - `System & Workspace`: `vcs.git`, `vcs.hg`, `sandbox`, `location-watcher`, `policy`, `instruction`, `warming`, `compaction`, `verbosity`.
   - `Other`: Fallback for external 3rd-party plugins.

2. **Presentation Surface Integration**:
   - **TUI Dialog** (`packages/tui/src/feature-plugins/system/plugins.tsx`): Options are grouped by canonical categories with bold accent headers, and `sectionNavigation: true` with `alt+↑/↓` hotkeys allows rapid jumping between sections.
   - **CLI List** (`packages/cli/src/commands/handlers/plugin/list.ts`): Output is structured by category sections with formatted tables for ID, STATUS, VERSION, and SOURCE.
   - **Agent Tool** (`packages/core/src/tool/plugin/plugin-forge.ts`): `{ action: "list" }` returns plugins grouped under category headers.

3. **Out-of-the-Box Antigravity OAuth Registration**:
   - Registered `AntigravityAuthEffectPlugin` from `@orchestra/plugin-antigravity-auth` in `packages/core/src/plugin/internal.ts` as an active built-in plugin (analogous to `BrowserPlugin` from `@orchestra/plugin-browser`).
   - Every fresh installation or clone now immediately features `opencode-antigravity-auth` in plugins and Google OAuth (`Google OAuth (Antigravity)`) in `orchestra auth login` without manual configuration.
   - Preserved full dynamic lifecycle: users can still enable, disable (`orchestra plugin disable opencode-antigravity-auth`), or remove the plugin at any time via CLI or `plugin_forge`.

## Consequences
- Clean Architecture L0-L6 layer integrity is preserved (L4 `@orchestra/core` depends on L3 `@orchestra/plugin-antigravity-auth`).
- 0 layer violations across all 36 monorepo packages.
- Zero decoupling leaks detected across all 6,245 files.
