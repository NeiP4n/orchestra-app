export * as ProjectFilesDescriptorsIntegrations from "./descriptors-integrations.js"

import type { FileDescriptor } from "./registry.js"

/**
 * Integrations and skills (slice S3). Each descriptor is filled in by
 * the slice together with its read/write/sync/compare/restore
 * implementation in `files-integrations.ts`.
 *
 * - `mcp.yaml` — MCP servers of this project (name, type, command/url;
 *   secrets only as credential-store references, never values), git, source file.
 * - `integrations/` — integration manifests (`.orchestra/integrations/<name>.yaml`),
 *   git, source file.
 * - `INTEGRATE.md` — the one instruction page for `orchestra integrate`, git, source file.
 * - `native-skills/skills.json` — validated skill registry of the project
 *   level (base `project`: a sibling of `.orchestra/`, not inside it).
 *   No git, source file. A damaged registry is a loud error, never a
 *   silent empty level (the levels module already logs damage and refuses
 *   installs over it; this slice wires it into the index and health).
 * - `skills/` + `skill-catalog` — marketplace skill content, no git, source file.
 */
export const DESCRIPTORS: ReadonlyArray<FileDescriptor> = []
