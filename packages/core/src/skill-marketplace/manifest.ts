export * as SkillMarketplaceManifest from "./manifest.js"

import { PORT_TYPES } from "./types.js"
import type { Dependency, Manifest, Port, PortType } from "./types.js"

/**
 * The manifest of a native skill, read from the YAML frontmatter of a
 * SKILL.md:
 *
 * ```md
 * ---
 * name: research-brief
 * version: 1.2.0
 * purpose: Turn a question into a sourced research brief.
 * inputs:
 *   - question:text
 *   - sources:list
 * outputs:
 *   - brief:report
 * depends:
 *   - json-tools@^1.0.0
 * rules:
 *   - Cite every claim with its source.
 * ---
 * ```
 *
 * There is no YAML parser in core, and the manifest is deliberately flat, so
 * this is a strict line parser, not a YAML engine: `key: value` lines and
 * `- item` lists under a list key. Anything it cannot read is an error, not a
 * guess — a skill with a broken manifest is refused at install, never
 * silently installed with half its ports.
 */

export interface Parsed {
  readonly manifest: Manifest | undefined
  /** The SKILL.md body with the frontmatter removed. */
  readonly body: string
  /** Every problem found; empty means the manifest is usable. */
  readonly errors: readonly string[]
}

const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/

/** A parsed semver triple. */
export type Version = readonly [number, number, number]

export const parseVersion = (value: string): Version | undefined => {
  const match = VERSION_PATTERN.exec(value.trim())
  if (match === null) return undefined
  return match[0].split(".").map(Number) as Version
}

const compareVersion = (a: Version, b: Version): number =>
  a[0] - b[0] || a[1] - b[1] || a[2] - b[2]

/**
 * Whether a version satisfies a range. Supported: `*`, an exact version,
 * `^1.2.0` (same major), `~1.2.0` (same major and minor), `>=1.2.0`,
 * `<=1.2.0`, `>1.2.0`, `<1.2.0`, and space-separated combinations such as
 * `>=1.0.0 <2.0.0`. Anything else is not a range and never matches.
 */
export const satisfies = (version: string, range: string): boolean => {
  const parsed = parseVersion(version)
  if (parsed === undefined) return false
  const trimmed = range.trim()
  if (trimmed === "" || trimmed === "*") return true
  return trimmed
    .split(/\s+/)
    .every((part) => satisfiesPart(parsed, part))
}

const satisfiesPart = (version: Version, part: string): boolean => {
  if (part.startsWith("^")) {
    const base = parseVersion(part.slice(1))
    return base !== undefined && compareVersion(version, base) >= 0 && version[0] === base[0]
  }
  if (part.startsWith("~")) {
    const base = parseVersion(part.slice(1))
    return (
      base !== undefined && compareVersion(version, base) >= 0 && version[0] === base[0] && version[1] === base[1]
    )
  }
  for (const [prefix, check] of [
    [">=", (n: number) => n >= 0],
    ["<=", (n: number) => n <= 0],
    [">", (n: number) => n > 0],
    ["<", (n: number) => n < 0],
    ["=", (n: number) => n === 0],
  ] as const) {
    if (part.startsWith(prefix)) {
      const base = parseVersion(part.slice(prefix.length))
      return base !== undefined && check(compareVersion(version, base))
    }
  }
  const base = parseVersion(part)
  return base !== undefined && compareVersion(version, base) === 0
}

/** The highest version in a list that satisfies a range, or `undefined` when none does. */
export const highestSatisfying = (versions: readonly string[], range: string): string | undefined => {
  const matching = versions.filter((version) => satisfies(version, range))
  return matching.sort((a, b) => compareVersion(parseVersion(a) as Version, parseVersion(b) as Version)).at(-1)
}

const parsePort = (value: string, field: string, errors: string[]): Port | undefined => {
  const [name, type] = value.split(":").map((part) => part.trim())
  if (name === undefined || name === "" || type === undefined || type === "") {
    errors.push(`${field}: "${value}" is not a port; write it as name:type, for example question:text.`)
    return undefined
  }
  if (!(PORT_TYPES as readonly string[]).includes(type)) {
    errors.push(`${field}: "${value}" uses unknown port type "${type}"; allowed: ${PORT_TYPES.join(", ")}.`)
    return undefined
  }
  return { name, type: type as PortType }
}

const parseDependency = (value: string, errors: string[]): Dependency | undefined => {
  const at = value.lastIndexOf("@")
  if (at <= 0) {
    errors.push(`depends: "${value}" is not a dependency; write it as name@range, for example json-tools@^1.0.0.`)
    return undefined
  }
  const name = value.slice(0, at).trim()
  const range = value.slice(at + 1).trim()
  if (name === "" || range === "") {
    errors.push(`depends: "${value}" is not a dependency; write it as name@range.`)
    return undefined
  }
  return { name, range }
}

interface Draft {
  name: string | undefined
  version: string | undefined
  purpose: string | undefined
  inputs: Port[]
  outputs: Port[]
  depends: Dependency[]
  rules: string[]
}

const emptyDraft = (): Draft => ({
  name: undefined,
  version: undefined,
  purpose: undefined,
  inputs: [],
  outputs: [],
  depends: [],
  rules: [],
})

/** Reads the frontmatter of a SKILL.md and turns it into a manifest. */
export const parse = (content: string): Parsed => {
  const lines = content.split(/\r?\n/)
  if (lines[0]?.trim() !== "---") return { manifest: undefined, body: content, errors: [] }
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---")
  if (end === -1) return { manifest: undefined, body: content, errors: ["The frontmatter never closes with ---."] }
  const errors: string[] = []
  const draft = emptyDraft()
  let list: "inputs" | "outputs" | "depends" | "rules" | undefined
  for (const line of lines.slice(1, end)) {
    if (line.trim() === "" || line.trim().startsWith("#")) continue
    const item = line.match(/^(\s*)-\s+(.*)$/)
    if (item !== null) {
      const value = item[2]?.trim() ?? ""
      if (list === "inputs" || list === "outputs") {
        const port = parsePort(value, list, errors)
        if (port !== undefined) draft[list].push(port)
      } else if (list === "depends") {
        const dependency = parseDependency(value, errors)
        if (dependency !== undefined) draft.depends.push(dependency)
      } else if (list === "rules") {
        if (value !== "") draft.rules.push(value)
      } else {
        errors.push(`A list item "${value}" appears before any list key.`)
      }
      continue
    }
    const field = line.match(/^([a-zA-Z][a-zA-Z0-9_-]*):\s*(.*)$/)
    if (field === null) {
      errors.push(`Cannot read line "${line.trim()}"; write fields as key: value.`)
      continue
    }
    const key = field[1] as string
    const value = (field[2] ?? "").trim()
    list = undefined
    if (key === "name" || key === "version" || key === "purpose") {
      draft[key] = value
      continue
    }
    if (key === "inputs" || key === "outputs" || key === "depends" || key === "rules") {
      if (value !== "") errors.push(`${key} takes a list; write one item per line starting with "- ".`)
      list = key
      continue
    }
    errors.push(`Unknown manifest field "${key}".`)
  }
  const body = lines.slice(end + 1).join("\n")
  const validation = validate(draft)
  return { manifest: validation.length === 0 ? finish(draft) : undefined, body, errors: [...errors, ...validation] }
}

const validate = (draft: Draft): string[] => {
  const errors: string[] = []
  if (draft.name === undefined || draft.name === "") errors.push("name is required.")
  else if (!NAME_PATTERN.test(draft.name)) errors.push(`name "${draft.name}" is not a slug: lowercase letters, digits, dashes.`)
  if (draft.version === undefined || draft.version === "") errors.push("version is required.")
  else if (parseVersion(draft.version) === undefined) errors.push(`version "${draft.version}" is not semver (x.y.z).`)
  if (draft.purpose === undefined || draft.purpose === "") errors.push("purpose is required.")
  for (const field of ["inputs", "outputs"] as const) {
    const names = draft[field].map((port) => port.name)
    if (new Set(names).size !== names.length) errors.push(`${field} repeats a port name.`)
  }
  if (draft.depends.some((dependency) => dependency.name === draft.name)) errors.push("A skill cannot depend on itself.")
  return errors
}

const finish = (draft: Draft): Manifest => ({
  name: draft.name as string,
  version: draft.version as string,
  purpose: draft.purpose as string,
  inputs: draft.inputs,
  outputs: draft.outputs,
  depends: draft.depends,
  rules: draft.rules,
  derived: false,
})

/**
 * A manifest for a skill that has none: the purpose is the first real line
 * of its text, the version is 0.0.0, and there are no ports — so it can run
 * alone but the factory can never chain it, because its inputs and outputs
 * are unknown. The `derived` flag says exactly that.
 */
export const derive = (name: string, content: string): Manifest => {
  const first = content
    .split(/\r?\n/)
    .map((line) => line.replace(/^#+\s*/, "").trim())
    .find((line) => line !== "" && !line.startsWith("---"))
  return {
    name,
    version: "0.0.0",
    purpose: first ?? `Skill ${name}.`,
    inputs: [],
    outputs: [],
    depends: [],
    rules: [],
    derived: true,
  }
}

/** Writes a manifest back as frontmatter, above a body. */
export const serialize = (manifest: Manifest, body: string): string => {
  const lines = [
    "---",
    `name: ${manifest.name}`,
    `version: ${manifest.version}`,
    `purpose: ${manifest.purpose}`,
  ]
  if (manifest.inputs.length > 0) {
    lines.push("inputs:")
    for (const port of manifest.inputs) lines.push(`  - ${port.name}:${port.type}`)
  }
  if (manifest.outputs.length > 0) {
    lines.push("outputs:")
    for (const port of manifest.outputs) lines.push(`  - ${port.name}:${port.type}`)
  }
  if (manifest.depends.length > 0) {
    lines.push("depends:")
    for (const dependency of manifest.depends) lines.push(`  - ${dependency.name}@${dependency.range}`)
  }
  if (manifest.rules.length > 0) {
    lines.push("rules:")
    for (const rule of manifest.rules) lines.push(`  - ${rule}`)
  }
  lines.push("---", "")
  return `${lines.join("\n")}${body}`
}
