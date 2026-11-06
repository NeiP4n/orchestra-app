export * as ProjectFilesIntegrations from "./files-integrations.js"

import { readdir } from "node:fs/promises"
import path from "node:path"
import { Effect, Schema } from "effect"
import { McpCatalog } from "../mcp/catalog.js"
import { SkillMarketplaceLevels } from "../skill-marketplace/levels.js"
import { ProjectFilesErrors } from "./errors.js"
import { ProjectFilesFormat } from "./format.js"
import type { Divergence } from "./health.js"
import { ProjectFilesPaths } from "./paths.js"

/**
 * Integrations and skills (slice S3).
 *
 * - `mcp.yaml` — the per-project MCP servers. The global MCP config only
 *   knows servers for the whole machine; a project that needs its own
 *   server had nowhere to put it. This file is that place, and the file
 *   IS the store (source `file`): sync validates it, restore leaves it
 *   alone. A secret VALUE in it is a bug — env/header values are plain
 *   non-secret strings or `{ credential: "<id>" }` references into the
 *   credential store — and the validator rejects a value loudly.
 * - `integrate(directory, spec)` — the minimal install flow from the
 *   integration DX drafts: recognise the type (catalog / MCP / REST /
 *   model provider) → validate the spec → install (write the manifest
 *   `.orchestra/integrations/<name>.yaml`, and for MCP/catalog also the
 *   server entry in `mcp.yaml`) → verify (offline shape checks only:
 *   the manifest parses back, the server entry is present, URLs are
 *   http(s) without credentials) → update `INTEGRATE.md` → report.
 *   No network is touched here: live probes (server start, tools/list,
 *   GET /models) belong to the dry-run step the CLI will own, not to
 *   this file layer. CLI wiring (`orchestra integrate`) is out of scope.
 * - `skills.json` — the project-level skill registry lives at
 *   `<project-dir>/native-skills/skills.json`, a SIBLING of `.orchestra/`,
 *   not inside it. The damage handling already exists in the levels
 *   module (`loadLevelDetailed` returns `degraded` and refuses installs
 *   over a damaged registry); this slice wires it into the project-files
 *   world: `checkSkillRegistry` surfaces a damaged registry as a health
 *   divergence instead of a silent empty level.
 *
 * PLUMBING GAP (reported, not hacked around): `ProjectFilesPaths`
 * (`writePath`/`readPath`) and the health check / index walker resolve
 * every descriptor inside `.orchestra/` and ignore `descriptor.base`,
 * so a base-`project` descriptor (`native-skills/skills.json`) is
 * indexed and health-checked at the WRONG path
 * (`.orchestra/native-skills/skills.json`). The descriptor is registered
 * as designed, but the real sibling path is only honoured by the
 * functions in this file (`skillRegistryPath`, `checkSkillRegistry`),
 * which compute it directly with `path.join` and surface damage through
 * the `divergences` parameter of `checkHealth`. Fixing the shared
 * plumbing is a core change, not a slice change.
 */

export const MCP_FILE = "mcp.yaml"
export const INTEGRATIONS_DIR = "integrations"
export const INTEGRATE_DOC = "INTEGRATE.md"
export const SKILLS_REGISTRY_REL = "native-skills/skills.json"
export const SKILLS_DIR = "skills/"
export const SKILL_CATALOG_DIR = "skill-catalog/"

/** A reference into the credential store — an id, never a secret value. */
export const CredentialRef = Schema.Struct({ credential: Schema.String })
export type CredentialRef = typeof CredentialRef.Type

/** An env/header value: a plain non-secret string, or a credential reference. */
const SecretFreeValue = Schema.Union([Schema.String, CredentialRef])

const NAME_PATTERN = /^[a-z][a-z0-9-]{1,63}$/
const SECRET_KEY = /(api[-_]?key|token|secret|passw(or)?d|authorization)/i
const ENV_NAME = /^[A-Z][A-Z0-9_]*$/

/** A key whose string value would be a secret: names like api_key, token, secret, password. */
const isSecretKey = (key: string): boolean => SECRET_KEY.test(key) || key.toLowerCase() === "auth"

/**
 * Walks a decoded value and collects every field that looks like a secret
 * held as a plain string. `credential` holds a store id, not a value;
 * `env` holds a variable NAME (e.g. `MY_API_KEY`), not a value — unless
 * the value is not shaped like a name, in which case it is flagged too.
 */
const scanSecrets = (value: unknown, at: string, problems: Array<string>): void => {
  if (value === null || typeof value !== "object") return
  if (Array.isArray(value)) {
    value.forEach((entry, index) => scanSecrets(entry, `${at}[${index}]`, problems))
    return
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === "string" && isSecretKey(key)) {
      const isNameField = key === "credential" || (key === "env" && ENV_NAME.test(entry))
      if (!isNameField) problems.push(`${at}${key} looks like a secret value — use { credential: "<id>" } instead`)
    }
    scanSecrets(entry, `${at}${key}.`, problems)
  }
}

/** A URL must be http(s) and must not carry credentials in it. */
const checkHttpUrl = (label: string, raw: string): string | undefined => {
  const url = URL.parse(raw)
  if (url === null) return `${label} is not a valid URL: ${raw}`
  if (url.protocol !== "http:" && url.protocol !== "https:") return `${label} must be http(s), got ${url.protocol}`
  if (url.username !== "" || url.password !== "") return `${label} must not carry credentials in the URL`
  return undefined
}

// ---------------------------------------------------------------------------
// mcp.yaml
// ---------------------------------------------------------------------------

/**
 * One per-project MCP server. Mirrors the global `ServerConfig` shape
 * (local command / remote url, protocol, timeout) with two differences:
 * env/header values are `string | { credential }` — never a secret value —
 * and auth is a credential-store id only (there is no `oauth` block with
 * a `client_secret` value to leak).
 */
export const McpServer = Schema.Struct({
  type: Schema.Literals(["local", "remote", "streamable-http"]),
  command: Schema.optional(Schema.Array(Schema.String)),
  url: Schema.optional(Schema.String),
  env: Schema.optional(Schema.Record(Schema.String, SecretFreeValue)),
  headers: Schema.optional(Schema.Record(Schema.String, SecretFreeValue)),
  credential: Schema.optional(Schema.String),
  disabled: Schema.optional(Schema.Boolean),
  protocol: Schema.optional(Schema.Literals(["legacy", "auto", "2026-07-28"])),
  timeoutMs: Schema.optional(Schema.Number),
})
export type McpServer = typeof McpServer.Type

export const McpFile = Schema.Struct({
  version: Schema.Literal(1),
  servers: Schema.Record(Schema.String, McpServer),
})
export type McpFile = typeof McpFile.Type

/** Validates a decoded `mcp.yaml`: shape, cross-field rules, and the secret scan. */
export const validateMcp = (value: unknown): Effect.Effect<McpFile, ProjectFilesErrors.ProjectFileError> =>
  Effect.gen(function* () {
    const file = yield* Schema.decodeUnknownEffect(McpFile)(value).pipe(
      Effect.mapError((error) =>
        ProjectFilesErrors.invalid(MCP_FILE, `mcp.yaml is not a valid per-project MCP file: ${error.message}`)
      ),
    )
    const problems: Array<string> = []
    for (const [name, server] of Object.entries(file.servers)) {
      if (server.type === "local" && (server.command === undefined || server.command.length === 0))
        problems.push(`server "${name}": a local server needs a non-empty command`)
      if (server.type === "local" && server.url !== undefined)
        problems.push(`server "${name}": a local server must not carry a url`)
      if (server.type !== "local" && (server.url === undefined || server.url === ""))
        problems.push(`server "${name}": a ${server.type} server needs a url`)
      if (server.timeoutMs !== undefined && (server.timeoutMs < 1_000 || server.timeoutMs > 600_000))
        problems.push(`server "${name}": timeoutMs must be 1_000..600_000, got ${server.timeoutMs}`)
      scanSecrets(server, `server "${name}".`, problems)
    }
    if (problems.length > 0) yield* Effect.fail(ProjectFilesErrors.invalid(MCP_FILE, problems.join("; ")))
    return file
  })

/** Reads `mcp.yaml`. Missing is a loud `missing` error — use `readMcpOrEmpty` for a fresh project. */
export const readMcp = (directory: string): Effect.Effect<McpFile, ProjectFilesErrors.ProjectFileError> =>
  ProjectFilesFormat.readYaml(ProjectFilesPaths.readPath(directory, MCP_FILE), McpFile).pipe(
    Effect.flatMap((value) => validateMcp(value)),
  )

/** Reads `mcp.yaml`, or an empty server list when the file does not exist yet. */
export const readMcpOrEmpty = (directory: string): Effect.Effect<McpFile, ProjectFilesErrors.ProjectFileError> =>
  readMcp(directory).pipe(
    Effect.catchTag("ProjectFiles.Error", (error) =>
      error.kind === "missing" ? Effect.succeed({ version: 1 as const, servers: {} }) : Effect.fail(error)
    ),
  )

/** Validates, then writes `mcp.yaml` atomically. */
export const writeMcp = (
  directory: string,
  value: unknown,
): Effect.Effect<void, ProjectFilesErrors.ProjectFileError> =>
  validateMcp(value).pipe(
    Effect.flatMap((file) => ProjectFilesFormat.writeYaml(ProjectFilesPaths.writePath(directory, MCP_FILE), file)),
  )

/** Adds (or replaces) one server in `mcp.yaml`, creating the file when it does not exist yet. */
export const addMcpServer = (
  directory: string,
  name: string,
  server: unknown,
): Effect.Effect<void, ProjectFilesErrors.ProjectFileError> =>
  Effect.gen(function* () {
    const current = yield* readMcpOrEmpty(directory)
    const next = yield* validateMcp({ version: 1, servers: { ...current.servers, [name]: server } })
    yield* ProjectFilesFormat.writeYaml(ProjectFilesPaths.writePath(directory, MCP_FILE), next)
  })

// ---------------------------------------------------------------------------
// Integration manifests (.orchestra/integrations/<name>.yaml)
// ---------------------------------------------------------------------------

export const IntegrationKind = Schema.Literals(["catalog", "mcp", "rest", "provider"])
export type IntegrationKind = typeof IntegrationKind.Type

/**
 * One integration manifest, following the DX drafts: `apiVersion`,
 * `kind`, `name`, `description`, `when` (mandatory — without it the model
 * cannot learn when to use the integration), `auth` by credential id,
 * `limits` (timeoutMs capped at 120_000), `sandbox` (allowlist hosts,
 * never `*`), then one section per kind. `catalog` installs a named
 * entry of the MCP catalog; `plugin` is NOT a kind here — a plugin is
 * code, and this slice only installs manifests.
 */
export const IntegrationManifest = Schema.Struct({
  apiVersion: Schema.Literal("orchestra/v1"),
  kind: IntegrationKind,
  name: Schema.String,
  description: Schema.String,
  when: Schema.String,
  auth: Schema.optional(
    Schema.Struct({
      type: Schema.Literals(["api-key", "oauth", "none", "env"]),
      credential: Schema.optional(Schema.String),
      header: Schema.optional(Schema.String),
      env: Schema.optional(Schema.String),
    }),
  ),
  limits: Schema.optional(
    Schema.Struct({
      timeoutMs: Schema.optional(Schema.Number),
      ratePerMin: Schema.optional(Schema.Number),
      budgetPerDay: Schema.optional(Schema.Number),
    }),
  ),
  sandbox: Schema.optional(
    Schema.Struct({
      allowWrite: Schema.optional(Schema.Boolean),
      allowNetwork: Schema.optional(Schema.Array(Schema.String)),
    }),
  ),
  requires: Schema.optional(Schema.Array(Schema.String)),
  catalog: Schema.optional(Schema.Struct({ entry: Schema.String })),
  mcp: Schema.optional(
    Schema.Struct({
      command: Schema.optional(Schema.Array(Schema.String)),
      url: Schema.optional(Schema.String),
      env: Schema.optional(Schema.Record(Schema.String, SecretFreeValue)),
      headers: Schema.optional(Schema.Record(Schema.String, SecretFreeValue)),
      credential: Schema.optional(Schema.String),
      protocol: Schema.optional(Schema.Literals(["legacy", "auto", "2026-07-28"])),
    }),
  ),
  rest: Schema.optional(
    Schema.Struct({
      baseUrl: Schema.String,
      openapi: Schema.optional(Schema.String),
      tools: Schema.optional(Schema.Array(Schema.String)),
    }),
  ),
  provider: Schema.optional(
    Schema.Struct({
      baseUrl: Schema.String,
      models: Schema.optional(Schema.Array(Schema.String)),
      defaultModel: Schema.optional(Schema.String),
      fallback: Schema.optional(Schema.String),
    }),
  ),
})
export type IntegrationManifest = typeof IntegrationManifest.Type

const manifestRel = (name: string): string => `${INTEGRATIONS_DIR}/${name}.yaml`

/** Validates a decoded manifest: shape, naming, `when`, limits, URLs, and the secret scan. */
export const validateManifest = (
  value: unknown,
): Effect.Effect<IntegrationManifest, ProjectFilesErrors.ProjectFileError> =>
  Effect.gen(function* () {
    const manifest = yield* Schema.decodeUnknownEffect(IntegrationManifest)(value).pipe(
      Effect.mapError((error) =>
        ProjectFilesErrors.invalid(
          INTEGRATIONS_DIR,
          `integration manifest is not valid: ${error.message}`,
        )
      ),
    )
    const problems: Array<string> = []
    if (!NAME_PATTERN.test(manifest.name))
      problems.push(`name "${manifest.name}" must match [a-z][a-z0-9-]{1,63}`)
    if (manifest.description.trim() === "") problems.push("description must not be empty")
    if (manifest.when.trim().length < 40)
      problems.push("when must say when to use the integration (at least 40 characters)")
    if (manifest.limits?.timeoutMs !== undefined && (manifest.limits.timeoutMs < 1_000 || manifest.limits.timeoutMs > 120_000))
      problems.push(`limits.timeoutMs must be 1_000..120_000, got ${manifest.limits.timeoutMs}`)
    if (manifest.sandbox?.allowNetwork?.includes("*"))
      problems.push("sandbox.allowNetwork must list concrete hosts, never *")
    if (manifest.kind === "catalog" && (manifest.catalog === undefined || manifest.catalog.entry.trim() === ""))
      problems.push("a catalog integration needs catalog.entry (the catalog name, e.g. serena)")
    if (manifest.kind === "mcp") {
      if (manifest.mcp === undefined) problems.push("an mcp integration needs an mcp section (command or url)")
      if (manifest.mcp?.command === undefined && manifest.mcp?.url === undefined)
        problems.push("an mcp integration needs mcp.command or mcp.url")
      if (manifest.mcp?.command !== undefined && manifest.mcp.command.length === 0)
        problems.push("mcp.command must not be empty")
      if (manifest.mcp?.command !== undefined && manifest.mcp?.url !== undefined)
        problems.push("an mcp integration needs mcp.command or mcp.url, not both")
    }
    if (manifest.kind === "rest") {
      if (manifest.rest === undefined) problems.push("a rest integration needs a rest section (baseUrl)")
      if (manifest.rest !== undefined) {
        const bad = checkHttpUrl("rest.baseUrl", manifest.rest.baseUrl)
        if (bad !== undefined) problems.push(bad)
        if (manifest.rest.openapi !== undefined) {
          const badOpenapi = checkHttpUrl("rest.openapi", manifest.rest.openapi)
          if (badOpenapi !== undefined) problems.push(badOpenapi)
        }
      }
    }
    if (manifest.kind === "provider") {
      if (manifest.provider === undefined) problems.push("a provider integration needs a provider section (baseUrl)")
      if (manifest.provider !== undefined) {
        const bad = checkHttpUrl("provider.baseUrl", manifest.provider.baseUrl)
        if (bad !== undefined) problems.push(bad)
        if (manifest.provider.models !== undefined && manifest.provider.models.some((model) => model.trim() === ""))
          problems.push("provider.models must not contain empty names")
        if (
          manifest.provider.defaultModel !== undefined &&
          manifest.provider.models !== undefined &&
          !manifest.provider.models.includes(manifest.provider.defaultModel)
        )
          problems.push(`provider.defaultModel "${manifest.provider.defaultModel}" is not in provider.models`)
      }
    }
    scanSecrets(manifest, "", problems)
    if (problems.length > 0)
      yield* Effect.fail(ProjectFilesErrors.invalid(manifestRel(manifest.name), problems.join("; ")))
    return manifest
  })

/** Reads one installed manifest by name. */
export const readManifest = (
  directory: string,
  name: string,
): Effect.Effect<IntegrationManifest, ProjectFilesErrors.ProjectFileError> =>
  ProjectFilesFormat.readYaml(
    ProjectFilesPaths.readPath(directory, manifestRel(name)),
    IntegrationManifest,
  ).pipe(Effect.flatMap((value) => validateManifest(value)))

/** Every installed manifest, sorted by name. A missing directory is no integrations, not an error. */
export const listIntegrations = (
  directory: string,
): Effect.Effect<ReadonlyArray<IntegrationManifest>, ProjectFilesErrors.ProjectFileError> =>
  Effect.gen(function* () {
    const dir = ProjectFilesPaths.writePath(directory, INTEGRATIONS_DIR)
    const names = yield* Effect.tryPromise({
      try: () => readdir(dir),
      catch: (error) => error,
    }).pipe(
      Effect.catch(() => Effect.succeed([] as ReadonlyArray<string>)),
    )
    const manifests: Array<IntegrationManifest> = []
    for (const name of names
      .filter((entry) => entry.endsWith(".yaml") || entry.endsWith(".yml"))
      .sort()) {
      manifests.push(yield* readManifest(directory, name.replace(/\.ya?ml$/, "")))
    }
    return manifests.sort((a, b) => (a.name < b.name ? -1 : 1))
  })

// ---------------------------------------------------------------------------
// INTEGRATE.md
// ---------------------------------------------------------------------------

const INTEGRATE_DOC_HEAD = `# INTEGRATE.md — how to connect anything in Orchestra (for an agent)

> Generated from the installed manifests — do not edit by hand, run a sync
> (or install another integration) to regenerate it.

## Commands

\`\`\`text
orchestra integrate <manifest|name|url> [--dry-run] [--kind rest|mcp|provider|plugin]
orchestra integrations list | search <query> | show <name> | check <name> | remove <name>
orchestra auth login <name> --answer key=<value>
\`\`\`

## Manifest (.orchestra/integrations/<name>.yaml)

apiVersion: orchestra/v1; kind; name; description; when; auth.credential (id!);
limits.timeoutMs (<=120000); sandbox.allowWrite/allowNetwork.
One manifest = one integration. \`when\` (at least 40 characters) is mandatory:
without it the model cannot learn when to use the integration.

## Secrets

A key lives only in the credential store, via \`auth login\`. Never in a file,
config, log, or chat. The validator rejects a manifest with a secret-like
value (api key, token, secret, password). In mcp.yaml, env/header values are
plain non-secret strings or \`{ credential: "<id>" }\`.

## Verification

1. \`integrate --dry-run\` → ok. 2. \`integrate\` → installed. 3. \`check\` → healthy.
First hour — read-only (allowWrite: false), then \`integrations trust <name>\`.
This layer verifies offline only: the manifest parses, the server entry is
present in mcp.yaml, URLs are http(s) without credentials. Live probes
(server start, tools/list, GET /models) are NOT done here.

## Errors

auth → check the credential; timeout → check the network and scope;
0 tools → check URL/command; rate_limited → wait or raise the limit;
unhealthy → check, then remove.

## Rules

Do not edit orchestra.json by hand. timeoutMs <= 120000. allowNetwork lists
concrete hosts, never *.
`

/** Regenerates `INTEGRATE.md` from the installed manifests (derived file: never hand-edited). */
export const updateIntegrateDoc = (
  directory: string,
): Effect.Effect<void, ProjectFilesErrors.ProjectFileError> =>
  Effect.gen(function* () {
    const installed = yield* listIntegrations(directory)
    const rows = installed.map(
      (manifest) => `| ${manifest.name} | ${manifest.kind} | ${manifest.description} |`,
    )
    const text =
      rows.length === 0
        ? `${INTEGRATE_DOC_HEAD}\n## Installed integrations\n\n(none yet)\n`
        : `${INTEGRATE_DOC_HEAD}\n## Installed integrations\n\n| name | kind | description |\n| --- | --- | --- |\n${rows.join("\n")}\n`
    yield* ProjectFilesFormat.writeText(ProjectFilesPaths.writePath(directory, INTEGRATE_DOC), text)
  })

// ---------------------------------------------------------------------------
// integrate(directory, spec)
// ---------------------------------------------------------------------------

export interface IntegrateReport {
  readonly name: string
  readonly type: IntegrationKind
  readonly status: "installed"
  readonly manifest: string
  readonly verified: boolean
  readonly durationMs: number
}

/**
 * The minimal install flow: recognise → validate → install → verify → report.
 * The manifest is written first, then (for MCP/catalog) the server entry in
 * `mcp.yaml`; `verify` re-reads both and reports `verified: false` instead
 * of failing when the second write did not land. Re-installing a name
 * without `force` is an error, never a silent overwrite.
 */
export const integrate = (
  directory: string,
  spec: unknown,
  options?: { force?: boolean },
): Effect.Effect<IntegrateReport, ProjectFilesErrors.ProjectFileError> =>
  Effect.gen(function* () {
    const startedAt = Date.now()
    const manifest = yield* validateManifest(spec)
    const rel = manifestRel(manifest.name)
    const file = ProjectFilesPaths.writePath(directory, rel)
    yield* ProjectFilesFormat.ensureDir(ProjectFilesPaths.writePath(directory, INTEGRATIONS_DIR))
    const exists = yield* ProjectFilesFormat.exists(file)
    if (exists && options?.force !== true)
      yield* Effect.fail(
        ProjectFilesErrors.invalid(rel, `integration "${manifest.name}" is already installed — pass force to overwrite`),
      )
    // A catalog install resolves the entry before anything is written: an
    // unknown catalog name is a loud error, not a manifest pointing nowhere.
    const catalogEntry =
      manifest.kind === "catalog"
        ? McpCatalog.all.find((entry) => entry.id === manifest.catalog?.entry)
        : undefined
    if (manifest.kind === "catalog" && catalogEntry === undefined)
      yield* Effect.fail(
        ProjectFilesErrors.invalid(rel, `unknown catalog entry "${manifest.catalog?.entry}"`),
      )
    yield* ProjectFilesFormat.writeYaml(file, manifest)
    if (manifest.kind === "mcp" && manifest.mcp !== undefined) {
      const server: McpServer = {
        type: manifest.mcp.url !== undefined && manifest.mcp.command === undefined ? "remote" : "local",
        ...(manifest.mcp.command !== undefined ? { command: manifest.mcp.command } : {}),
        ...(manifest.mcp.url !== undefined ? { url: manifest.mcp.url } : {}),
        ...(manifest.mcp.env !== undefined ? { env: manifest.mcp.env } : {}),
        ...(manifest.mcp.headers !== undefined ? { headers: manifest.mcp.headers } : {}),
        ...(manifest.mcp.credential !== undefined ? { credential: manifest.mcp.credential } : {}),
        ...(manifest.mcp.protocol !== undefined ? { protocol: manifest.mcp.protocol } : {}),
      }
      yield* addMcpServer(directory, manifest.name, server)
    }
    if (manifest.kind === "catalog" && catalogEntry !== undefined) {
      yield* addMcpServer(directory, manifest.name, catalogEntry.config)
    }
    const verified = yield* verifyInstalled(directory, manifest).pipe(Effect.catch(() => Effect.succeed(false)))
    yield* updateIntegrateDoc(directory)
    return {
      name: manifest.name,
      type: manifest.kind,
      status: "installed" as const,
      manifest: rel,
      verified,
      durationMs: Date.now() - startedAt,
    }
  })

/**
 * Offline verification: the manifest parses back, and for MCP/catalog the
 * server entry is present in `mcp.yaml`. REST/provider manifests only
 * need their endpoint shape, which validation already checked.
 */
export const verifyInstalled = (
  directory: string,
  manifest: IntegrationManifest,
): Effect.Effect<boolean, ProjectFilesErrors.ProjectFileError> =>
  Effect.gen(function* () {
    yield* readManifest(directory, manifest.name)
    if (manifest.kind === "mcp" || manifest.kind === "catalog") {
      const mcp = yield* readMcp(directory)
      return mcp.servers[manifest.name] !== undefined
    }
    return true
  })

// ---------------------------------------------------------------------------
// skills.json (project level, sibling of .orchestra/)
// ---------------------------------------------------------------------------

/** Absolute path of the project-level skill registry — a sibling of `.orchestra/`, not inside it. */
export const skillRegistryPath = (directory: string): string => path.join(directory, SKILLS_REGISTRY_REL)

/** Loads the project-level registry with its damage marker (never throws: damage is data). */
export const readSkillRegistry = (
  directory: string,
): Effect.Effect<SkillMarketplaceLevels.LevelLoad> =>
  SkillMarketplaceLevels.loadLevelDetailed(
    { society: undefined, project: directory, session: undefined },
    "project",
  )

/**
 * The health divergence for a damaged project skill registry. A missing
 * registry is an empty level (fresh project), not damage; a damaged one
 * is a divergence with the reason, so `checkHealth(dir, divergences)`
 * shows it instead of the level reading as silently empty.
 */
export const checkSkillRegistry = (
  directory: string,
): Effect.Effect<ReadonlyArray<Divergence>> =>
  readSkillRegistry(directory).pipe(
    Effect.map((loaded) =>
      loaded.degraded
        ? [
            {
              path: SKILLS_REGISTRY_REL,
              detail:
                `project skill registry is damaged: ${loaded.damage ?? "unknown damage"} — ` +
                `fix or remove ${SKILLS_REGISTRY_REL}; installs are refused over a damaged registry`,
            },
          ]
        : [],
    ),
  )
