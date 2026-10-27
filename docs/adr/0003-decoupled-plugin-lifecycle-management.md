# ADR 0003: Decoupled Plugin Lifecycle Management with CLI Enable/Disable and Plugin Forge Tool

## Status
**Accepted**

## Date
2026-10-28

## Context
In ADR 0002, `packages/plugin-antigravity-auth` was integrated as a workspace package under L3. However, hardcoding it statically into `packages/core/src/plugin/internal.ts` turned it into an indelible built-in plugin that could not be uninstalled, toggled, or selectively managed by operators via the plugin registry without rebuilding the core engine.

To support true modularity:
1. Plugins must be decoupled from being hardcoded static built-ins in `packages/core`.
2. Plugins must be separately installable, removable, enableable, and disableable via configuration (`plugins: [...]` and `plugins: ["-..."]`).
3. The CLI must provide explicit `orchestra plugin enable <target>` and `orchestra plugin disable <target>` subcommands alongside `list`, `add`, and `remove`.
4. Orchestra itself (via an AI tool `plugin_forge`) must have native autonomy to manage the plugin registry: listing, installing, removing, enabling, and disabling plugins.

## Decision
1. **Core Decoupling**:
   - Removed `AntigravityAuthEffectPlugin` from `packages/core/src/plugin/internal.ts`'s static built-in `post` pipeline and removed `@orchestra/plugin-antigravity-auth` dependency from `packages/core/package.json`.
   - Plugins (including `packages/plugin-antigravity-auth`) are loaded dynamically via `ConfigPluginSource` and `PluginModule` through configuration or workspace discovery.
   - Enhanced `PluginSupervisor` (`packages/core/src/plugin/supervisor.ts`) with `matchesPlugin`, supporting matching by plugin ID, package specifier (`plugin.source.target`), and local path (`plugin.source.path`).

2. **CLI Enable/Disable Subcommands**:
   - Added `enable` and `disable` subcommands to `Commands.commands.plugin` in `packages/cli/src/commands/commands.ts`.
   - Implemented `packages/cli/src/commands/handlers/plugin/enable.ts`:
     * Enables a plugin by removing the `"-"` prefix from its entry or appending it to `plugins` configuration.
   - Implemented `packages/cli/src/commands/handlers/plugin/disable.ts`:
     * Disables a plugin by prefixing its entry with `"-"` without deleting user configurations.
   - Updated `packages/cli/src/commands/handlers/plugin/remove.ts` with flexible matching.
   - Updated `packages/cli/src/commands/handlers/plugin/list.ts` to output plugin lifecycle status (`active`, `disabled`, `failed`) across both server and TUI configurations.

3. **Autonomous AI Management via `plugin_forge`**:
   - Created `packages/core/src/tool/plugin/plugin-forge.ts` registering the `plugin_forge` tool.
   - Supports actions: `list`, `add`, `remove`, `enable`, and `disable`.
   - Modifies configuration directly via `Config.Service.update`, triggering live supervisor reactivation/deactivation in live agent sessions.

4. **Layer and Architecture Compliance**:
   - Tool `plugin_forge` resides in L4 (`packages/core/src/tool/plugin/plugin-forge.ts`) alongside `mcp_forge` and `command_forge`.
   - CLI handlers reside in L6 (`packages/cli/src/commands/handlers/plugin/`).
   - Plugin `@orchestra/plugin-antigravity-auth` resides in L3 (`packages/plugin-antigravity-auth`).

## Consequences
- Plugins can be installed, removed, enabled, and disabled dynamically without modifying core engine binaries.
- Operators and AI agents (Orchestra) have complete control over plugin lifecycles via CLI and the `plugin_forge` tool.
- Zero mocks or stubs: all operations manipulate real JSONC configurations and live Effect services.
