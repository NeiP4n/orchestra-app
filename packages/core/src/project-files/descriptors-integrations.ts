export * as ProjectFilesDescriptorsIntegrations from "./descriptors-integrations.js"

import type { FileDescriptor } from "./registry.js"

/**
 * Integrations and skills (slice S3). Implemented in
 * `files-integrations.ts` together with the read/write/sync/compare/
 * restore behaviour.
 *
 * - `mcp.yaml` — MCP servers of this project (name, type, command/url;
 *   secrets only as credential-store references, never values), git, source file.
 *   Git: the file holds configuration, never a secret value — the secret
 *   scanner in `files-integrations.ts` rejects a value loudly, so
 *   versioning it is safe.
 * - `integrations/` — integration manifests (`.orchestra/integrations/<name>.yaml`),
 *   git, source file. Same reasoning: a manifest with a secret value is
 *   rejected at install time, so the directory is safe to version.
 * - `INTEGRATE.md` — the one instruction page for `orchestra integrate`,
 *   git, source file. A doc, no secrets, regenerated from the installed
 *   manifests on sync.
 * - `native-skills/skills.json` — validated skill registry of the project
 *   level (base `project`: a sibling of `.orchestra/`, not inside it).
 *   No git, source file. A damaged registry is a loud error, never a
 *   silent empty level (the levels module already logs damage and refuses
 *   installs over it; this slice wires it into health via divergences).
 * - `skills/` + `skill-catalog/` — marketplace skill content, no git,
 *   source file. `skill-catalog/` is the cache the marketplace store
 *   already writes (`.orchestra/skill-catalog/skills.jsonl` + `meta.json`);
 *   this slice registers its location instead of duplicating it.
 */
export const DESCRIPTORS: ReadonlyArray<FileDescriptor> = [
  {
    rel: "mcp.yaml",
    base: "orchestra",
    dir: false,
    kind: "mcp",
    purpose: "Per-project MCP servers: command or url per server; secrets only as credential-store references, never values",
    git: true,
    source: "file",
  },
  {
    rel: "integrations/",
    base: "orchestra",
    dir: true,
    kind: "integration",
    purpose: "Integration manifests: one .orchestra/integrations/<name>.yaml per installed integration (catalog, MCP, REST, provider)",
    git: true,
    source: "file",
  },
  {
    rel: "INTEGRATE.md",
    base: "orchestra",
    dir: false,
    kind: "docs",
    purpose: "The one instruction page for `orchestra integrate`: commands, manifest rules, secret rules, error table, installed list",
    git: true,
    source: "file",
  },
  {
    rel: "native-skills/skills.json",
    base: "project",
    dir: false,
    kind: "skills",
    purpose: "Validated skill registry of the project level (sibling of .orchestra/, not inside it); a damaged registry is a loud error, never a silent empty level",
    git: false,
    source: "file",
  },
  {
    rel: "skills/",
    base: "orchestra",
    dir: true,
    kind: "skills",
    purpose: "Project skill content: installed native skills for this project",
    git: false,
    source: "file",
  },
  {
    rel: "skill-catalog/",
    base: "orchestra",
    dir: true,
    kind: "catalog",
    purpose: "Cached upstream skill catalog for this project (skills.jsonl + meta.json, written by the marketplace store)",
    git: false,
    source: "file",
  },
]
