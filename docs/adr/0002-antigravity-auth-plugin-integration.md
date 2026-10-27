# ADR 0002: Native Monorepo Integration of Google Antigravity Auth Plugin

## Status
**Accepted**

## Date
2026-10-28

## Context
Google Antigravity OAuth provider integration enables account rotation, live model discovery, quota checking, and custom search transforms across Gemini 3.8 Flash, Pro, and Claude models. Previously, this capability was consumed via external paths (`C:/Users/Isako/.local/share/orchestra/plugins-npm/node_modules/opencode-antigravity-auth`).

To make Antigravity Auth a native, first-class capability of Orchestra:
1. The full, authentic plugin implementation from `https://github.com/NoeFabris/opencode-antigravity-auth` must be integrated into the monorepo without any simulation, stubbing, or mocks.
2. The plugin must adhere to Orchestra's Clean Architecture L0–L6 layer boundaries and decoupling guardrails.
3. Both Promise-based (`Plugin.define`) and Effect-based (`fromPromise`) lifecycles must be supported so the plugin runs seamlessly as a built-in Core plugin and as a standalone workspace module.

## Decision
1. **Workspace Package (`@orchestra/plugin-antigravity-auth`)**:
   - Integrated as a first-class package under `packages/plugin-antigravity-auth`.
   - Classified under **Layer 3 (Plugins & Extensibility)** in `script/audit-layers.ts` and `SYSTEM_MAP.md`.
   - Maintained full dual-entrypoint API:
     * OpenCode V1/V2 default export `{ ...AntigravityV2Plugin, server: legacyServer }`.
     * Effect-native export `AntigravityAuthEffectPlugin = fromPromise(AntigravityV2Plugin)`.
     * TUI menu export `@orchestra/plugin-antigravity-auth/tui`.

2. **Core Built-in Registration**:
   - Added `@orchestra/plugin-antigravity-auth` dependency to `packages/core/package.json`.
   - Registered `AntigravityAuthEffectPlugin` into `packages/core/src/plugin/internal.ts` in the `post` plugin pipeline alongside `BrowserPlugin`.
   - Any Orchestra instance now boots with Antigravity Auth built in, requiring zero external npm installations.

3. **Decoupling and Layer Integrity Guardrails**:
   - Added structured allowlist entry in `script/check-decoupling.ts` covering `packages/plugin-antigravity-auth/`.
   - Verified L0–L6 downward dependency flow: `packages/core` (L4) imports `@orchestra/plugin-antigravity-auth` (L3), strictly preserving Clean Architecture invariants.

4. **Zero-Mock Verification**:
   - `audit:layers`: 36 packages validated across L0-L6 with 0 violations.
   - `check:decoupling`: 6,241 files scanned across monorepo with 0 leaks.
   - `packages/plugin-antigravity-auth`: Full build and TypeScript typecheck pass with exit code 0.
   - `packages/core`: Typecheck passes with exit code 0; all 19 plugin lifecycle tests pass.

## Consequences
- Native, zero-setup Google Antigravity OAuth authentication with multi-account rotation and quota checking.
- Clean Architecture invariants preserved across all monorepo layers.
- Strict 100% real code compliance without mocks.
