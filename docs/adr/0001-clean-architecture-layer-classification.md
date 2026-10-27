[Reading 45 lines from start (total: 45 lines, 0 remaining)]

# ADR 0001: Clean Architecture Layer Classification and Dependency Auditor

## Status
**Accepted**

## Date
2026-10-28

## Context
Orchestra is a multi-agent AI engineering platform structured as a strict layered monorepo (L0–L6). The architectural rule mandates that runtime dependencies must flow strictly downwards:
```
Surface (L6) -> Transport (L5) -> Domain (L4) -> Plugins (L3) -> Client (L2) -> Contract (L1) -> Leaf (L0)
```

During the Universal System Integrity audit, the dependency auditor revealed 3 apparent layer violations:
1. `packages/latex` (classified as L1) depended on `@orchestra/plugin` (L3).
2. `packages/merman` (classified as L1) depended on `@orchestra/plugin` (L3).
3. `packages/plugin-browser` (classified as L2) depended on `@orchestra/plugin` (L3).

Inspection of these packages demonstrated that:
- `@orchestra/latex` and `@orchestra/merman` are OpenTUI markdown plugins implementing the plugin contract exported by `@orchestra/plugin`. They are consumed exclusively by presentation layers (`packages/cli`, `packages/tui`).
- `@orchestra/plugin-browser` is a host plugin providing desktop browser integration for `packages/core` and `packages/gui-extensions`.
- All three are domain extensions/plugins, not pure protocol contracts (L1) or client adapters (L2).

## Decision
1. **Layer Reclassification**:
   - Classify `@orchestra/latex`, `@orchestra/merman`, and `@orchestra/plugin-browser` under **Layer 3 (Plugins & Extensibility)** alongside `@orchestra/plugin`, `services/idea-bank`, and `services/files`.
   - Update `SYSTEM_MAP.md` to reflect this clean architectural topology.

2. **Automated Auditor Tooling**:
   - Implement `script/audit-layers.ts` as the canonical dependency auditor for Layer 0 through Layer 6.
   - Register `"audit:layers": "bun run script/audit-layers.ts"` in root `package.json`.
   - Enforce that:
     * No package runtime dependency points to a higher layer.
     * `@orchestra/schema` (L0) has zero internal package dependencies.
     * `@orchestra/client` (L2) runtime code never imports from `packages/core` or `packages/server`.

3. **Multi-Agent Software Factory Verification**:
   - Formulate the 5-stage Definition of Done in `.orchestra/dod.yaml`.
   - Guarantee that every milestone executes real verification commands (compilers, test runners, AST/dependency scanners).

## Consequences
- **Integrity**: 35 packages across L0-L6 pass automated layer validation with 0 violations.
- **Traceability**: All architectural boundaries are backed by executable verification scripts.
- **Decoupling**: Complete isolation of leaf schemas (L0) and client contracts (L2) from internal execution engines (L4/L5).