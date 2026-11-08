export * as SelfSources from "./sources.js"

// The self index (idea: "Orchestra knows itself 100%") — what the agent can
// ask about Orchestra itself: its CLI commands, its config keys, its
// environment variables, its tools and extension points, its own docs, and
// whatever extra documents the operator adds.
//
// Every collector here derives its documents from the shipped sources, never
// from a hand-maintained copy: a command or config key that disappears from
// the code disappears from the index on the next rebuild. The collectors are
// deliberately plain synchronous functions over text, like the codegraph
// indexer — no imports of cli or schema modules, so the layering rules
// (schema → core → server → cli) are never at risk, and a malformed source
// file degrades one kind of document instead of breaking the boot.

import fs from "node:fs"
import path from "node:path"
import { ENV_REGISTRY } from "../env-registry.js"

export type SelfDocKind = "command" | "config" | "env" | "tool" | "extension" | "doc" | "custom"

export interface SelfDoc {
  /** Stable identity: `<kind>:<name>`. Rebuilt from scratch every run, so ids only compare within one build. */
  readonly id: string
  readonly kind: SelfDocKind
  readonly title: string
  readonly body: string
  /** Repo-relative file the document was derived from, when there is one. */
  readonly path?: string
}

const DOC_BODY_LIMIT = 2000

/** Every file a full collect reads, for staleness fingerprints. Missing files are skipped, not fatal. */
export function harvestedFiles(root: string): string[] {
  const fixed = [
    "package.json",
    "AI_ATLAS.md",
    "AGENTS.md",
    "packages/cli/src/commands/commands.ts",
    "packages/schema/src/config.ts",
    "packages/core/src/env-registry.ts",
  ]
  const plugins = listToolPluginFiles(root)
  return [...fixed, ...plugins].filter((file) => fs.existsSync(path.join(root, file)))
}

export function collect(root: string, options: { customPaths?: readonly string[]; docs?: boolean } = {}): SelfDoc[] {
  const docs = [
    ...envDocs(),
    ...commandDocs(root),
    ...configDocs(root),
    ...toolDocs(root),
    ...extensionDocs(),
    ...(options.docs === false ? [] : markdownDocs(root)),
    ...customDocs(options.customPaths ?? []),
  ]
  // Ids are a document's only identity in the store; a collision would silently
  // drop one of the two, so later duplicates get a suffix instead.
  const seen = new Map<string, number>()
  return docs.map((doc) => {
    const count = seen.get(doc.id) ?? 0
    seen.set(doc.id, count + 1)
    return count === 0 ? doc : { ...doc, id: `${doc.id}~${count + 1}` }
  })
}

/** Every ORCHESTRA_* variable, from the registry the env-registry test keeps in sync with the code. */
export function envDocs(): SelfDoc[] {
  return Object.entries(ENV_REGISTRY).map(([name, entry]) => ({
    id: `env:${name}`,
    kind: "env" as const,
    title: name,
    body: [entry.purpose, entry.default ? `Default: ${entry.default}` : undefined, entry.legacy ? "(legacy)" : undefined]
      .filter(Boolean)
      .join(" "),
    path: "packages/core/src/env-registry.ts",
  }))
}

const COMMANDS_FILE = "packages/cli/src/commands/commands.ts"

/**
 * The CLI command tree from the Spec definitions in commands.ts. Nested
 * `Spec.make` calls inside a `commands: [...]` block inherit their parent's
 * name, so `plugin add` is found as "plugin add", not as a bare "add".
 */
export function commandDocs(root: string): SelfDoc[] {
  const file = path.join(root, COMMANDS_FILE)
  if (!fs.existsSync(file)) return []
  const text = fs.readFileSync(file, "utf8")
  return collectSpecs(text).map((command) => ({
    id: `command:${command.name}`,
    kind: "command" as const,
    title: command.name,
    body: command.description ?? "(no description in the command spec)",
    path: COMMANDS_FILE,
  }))
}

interface SpecEntry {
  readonly name: string
  readonly description?: string
}

function collectSpecs(text: string, prefix?: string): SpecEntry[] {
  const entries: SpecEntry[] = []
  const marker = /Spec\.make\s*\(/g
  while (marker.exec(text) !== null) {
    const open = marker.lastIndex - 1
    const close = matchingParen(text, open)
    if (close === -1) break
    const inner = text.slice(open + 1, close)
    const comma = topLevelComma(inner)
    if (comma === -1) continue
    const rawName = inner.slice(0, comma).trim()
    // The root command names itself through a build-time ternary
    // (`typeof ORCHESTRA_CLI_NAME === "string" ? ... : "orchestra"`); its
    // fallback literal is the last string in the expression.
    const nameMatch = rawName.includes("?") ? /:\s*"([^"]+)"\s*$/.exec(rawName) : /"([^"]+)"/.exec(rawName)
    marker.lastIndex = close + 1
    if (!nameMatch) continue
    const name = prefix ? `${prefix} ${nameMatch[1]}` : nameMatch[1]!
    const head = inner.slice(0, firstNestedSpec(inner))
    const description = /description:\s*"([^"]+)"/.exec(head)?.[1]
    entries.push({ name, ...(description ? { description } : {}) })
    for (const nested of collectSpecs(inner, name)) entries.push(nested)
  }
  return entries
}

function firstNestedSpec(text: string): number {
  const nested = /Spec\.make\s*\(/.exec(text)
  return nested === null ? text.length : nested.index
}

/** Index of the first comma at nesting depth zero, or -1. */
function topLevelComma(text: string): number {
  let depth = 0
  let quote: string | undefined
  for (let index = 0; index < text.length; index++) {
    const character = text[index]!
    if (quote) {
      if (character === "\\") index++
      else if (character === quote) quote = undefined
      continue
    }
    if (character === '"' || character === "'" || character === "`") quote = character
    else if (character === "(" || character === "{" || character === "[") depth++
    else if (character === ")" || character === "}" || character === "]") depth--
    else if (character === "," && depth === 0) return index
  }
  return -1
}

/** Index of the paren that closes the one at `open`, or -1 when unbalanced. */
function matchingParen(text: string, open: number): number {
  let depth = 0
  let quote: string | undefined
  for (let index = open; index < text.length; index++) {
    const character = text[index]!
    if (quote) {
      if (character === "\\") index++
      else if (character === quote) quote = undefined
      continue
    }
    if (character === '"' || character === "'" || character === "`") quote = character
    else if (character === "(") depth++
    else if (character === ")") {
      depth--
      if (depth === 0) return index
    }
  }
  return -1
}

const CONFIG_FILE = "packages/schema/src/config.ts"

/**
 * The top-level config keys from the `Config.Info` schema class, each with
 * the description its field already carries in an `.annotate(...)`. Fields
 * without a description are indexed by name alone: the agent should still
 * learn the key exists.
 */
export function configDocs(root: string): SelfDoc[] {
  const file = path.join(root, CONFIG_FILE)
  if (!fs.existsSync(file)) return []
  const text = fs.readFileSync(file, "utf8")
  const start = text.indexOf('("Config.Info")({')
  if (start === -1) return []
  // Only the Config.Info class body: the Patch struct and the Document and
  // Directory classes further down repeat field names (shell, type, path).
  const end = text.indexOf(") {}", start)
  if (end === -1) return []
  const body = text.slice(start, end)
  const docs: SelfDoc[] = []
  const field = /^ {2}(\w+):/gm
  const fields: { key: string; from: number }[] = []
  let match: RegExpExecArray | null
  while ((match = field.exec(body)) !== null) fields.push({ key: match[1]!, from: match.index })
  for (let index = 0; index < fields.length; index++) {
    const current = fields[index]!
    const until = index + 1 < fields.length ? fields[index + 1]!.from : body.indexOf("}) {}", current.from)
    const block = body.slice(current.from, until === -1 ? undefined : until)
    const description = /description:\s*"([^"]+)"/.exec(block)?.[1]
    docs.push({
      id: `config:${current.key}`,
      kind: "config",
      title: current.key,
      body: description ?? "(no description in the config schema)",
      path: CONFIG_FILE,
    })
  }
  return docs
}

const TOOL_PLUGIN_DIR = "packages/core/src/tool/plugin"
const TOOL_BODY_LIMIT = 1000

/** The full description the tool advertises to the model: every line of the array form, or the single string. */
function toolDescription(text: string): string | undefined {
  const array = /export const description\s*=\s*\[([\s\S]*?)\]\s*\.join/.exec(text)
  const joined = array
    ? [...array[1]!.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((line) => line[1]).join("\n")
    : /export const description\s*=\s*"((?:[^"\\]|\\.)*)"/.exec(text)?.[1]
  if (!joined) return undefined
  return joined.length > TOOL_BODY_LIMIT ? `${joined.slice(0, TOOL_BODY_LIMIT)}…` : joined
}

function listToolPluginFiles(root: string): string[] {
  const dir = path.join(root, TOOL_PLUGIN_DIR)
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .filter((file) => file.endsWith(".ts"))
    .sort()
    .map((file) => `${TOOL_PLUGIN_DIR}/${file}`)
}

/** One document per built-in tool plugin: the name the model calls it by and its own first description line. */
export function toolDocs(root: string): SelfDoc[] {
  const docs: SelfDoc[] = []
  for (const relative of listToolPluginFiles(root)) {
    const text = fs.readFileSync(path.join(root, relative), "utf8")
    const name = /export const name = "([^"]+)"/.exec(text)?.[1]
    if (!name) continue
    docs.push({
      id: `tool:${name}`,
      kind: "tool",
      title: name,
      body: toolDescription(text) ?? "(no description in the tool plugin)",
      path: relative,
    })
  }
  return docs
}

/**
 * The extension points an operator can grow Orchestra with. The text is
 * short on purpose and points at the file that owns the mechanism, so the
 * agent's next step is always a read of the real thing.
 */
export function extensionDocs(): SelfDoc[] {
  const points: [string, string, string][] = [
    [
      "orchestra-folder",
      "The .orchestra project folder",
      "Per-project state and configuration: mcp.yaml (MCP servers), dod.yaml (definition of done), project.json, notes, memory. See packages/core/src/project-files/ and .gitignore for what is committed versus local.",
    ],
    [
      "plugins",
      "Plugins",
      "External plugin packages declared in config key `plugins`; built-in tool plugins live in packages/core/src/tool/plugin/ and register through Tool.Service.transform (see packages/core/src/tool/AGENTS.md).",
    ],
    [
      "mcp",
      "MCP servers",
      "Config key `mcp.servers` or .orchestra/mcp.yaml; MCP tools install through one stable tool transform (packages/core/src/tool/mcp.ts).",
    ],
    [
      "agents",
      "Custom agents",
      "Config key `agents`: named agent definitions and built-in overrides (packages/schema/src/config/agent.ts).",
    ],
    [
      "slash-commands",
      "Custom slash commands",
      "Config key `commands`: named slash command definitions (packages/schema/src/config/command.ts); the runtime registry is packages/core/src/command.ts.",
    ],
    [
      "skills",
      "Skills",
      "Config key `skills`: additional paths or URLs to discover skills from; the registry is packages/core/src/skill.ts.",
    ],
    [
      "instructions",
      "Ambient instructions",
      "Config key `instructions` plus AGENTS.md discovery (packages/core/src/instruction-discovery.ts): text injected into session context.",
    ],
    [
      "self-index",
      "Self index custom paths",
      "Config key `self_index.paths`: extra markdown or text files of the operator's own that this index includes, so the agent knows them too.",
    ],
  ]
  return points.map(([slug, title, body]) => ({ id: `extension:${slug}`, kind: "extension" as const, title, body }))
}

const DOC_FILES = ["AI_ATLAS.md", "AGENTS.md"]

/** The repo's own guidance, one document per `##` section so a search hit quotes one section, not the file. */
export function markdownDocs(root: string): SelfDoc[] {
  const docs: SelfDoc[] = []
  for (const relative of DOC_FILES) {
    const file = path.join(root, relative)
    if (!fs.existsSync(file)) continue
    const text = fs.readFileSync(file, "utf8")
    const sections = text.split(/^## /m)
    const overview = sections[0]?.trim()
    if (overview) docs.push(doc(relative, "overview", `${relative} — overview`, overview))
    for (const section of sections.slice(1)) {
      const newline = section.indexOf("\n")
      const heading = (newline === -1 ? section : section.slice(0, newline)).trim()
      const body = (newline === -1 ? "" : section.slice(newline)).trim()
      if (!heading || !body) continue
      docs.push(doc(relative, heading, `${relative} — ${heading}`, body))
    }
  }
  return docs
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

function doc(file: string, slug: string, title: string, body: string): SelfDoc {
  return {
    id: `doc:${file}#${slugify(slug)}`,
    kind: "doc",
    title,
    body: body.length > DOC_BODY_LIMIT ? `${body.slice(0, DOC_BODY_LIMIT)}…` : body,
    path: file,
  }
}

/** The operator's own documents, from `self_index.paths`: markdown is split by section, other text whole. */
export function customDocs(paths: readonly string[]): SelfDoc[] {
  const docs: SelfDoc[] = []
  for (const added of paths) {
    if (!fs.existsSync(added)) continue
    const text = fs.readFileSync(added, "utf8")
    if (added.endsWith(".md")) {
      const sections = text.split(/^## /m)
      const overview = sections[0]?.trim()
      if (overview) docs.push(custom(added, "overview", overview))
      for (const section of sections.slice(1)) {
        const newline = section.indexOf("\n")
        const heading = (newline === -1 ? section : section.slice(0, newline)).trim()
        const body = (newline === -1 ? "" : section.slice(newline)).trim()
        if (!heading || !body) continue
        docs.push(custom(added, heading, `${heading}: ${body}`))
      }
    } else {
      docs.push(custom(added, undefined, text))
    }
  }
  return docs
}

function custom(file: string, section: string | undefined, body: string): SelfDoc {
  const trimmed = body.length > DOC_BODY_LIMIT ? `${body.slice(0, DOC_BODY_LIMIT)}…` : body
  return {
    id: `custom:${file}${section ? `#${slugify(section)}` : ""}`,
    kind: "custom",
    title: section ? `${path.basename(file)} — ${section}` : path.basename(file),
    body: trimmed,
    path: file,
  }
}
