#!/usr/bin/env bun
// Prints a compact map of a TypeScript file — the declarations that start in the first column, with
// their line numbers — so finding a symbol costs one small command instead of reading the file in
// slices. Only top-level declarations are listed: indented code belongs to a body and the map would
// stop being a map.
//
// Usage: bun script/map.ts packages/core/src/orchestra.ts
//        bun script/map.ts packages/core/src/orchestra.ts --body 120-150
import path from "node:path"

const args = process.argv.slice(2)
if (args.includes("--help") || args.includes("-h") || args.length === 0) {
  console.log("usage: bun script/map.ts <file.ts> [--body <from>-<to>]")
  process.exit(args.length === 0 ? 1 : 0)
}

const bodyIndex = args.findIndex((arg) => arg === "--body" || arg.startsWith("--body="))
const bodyValue =
  bodyIndex === -1
    ? undefined
    : args[bodyIndex].startsWith("--body=")
      ? args[bodyIndex].slice("--body=".length)
      : args[bodyIndex + 1]
const body = bodyValue === undefined ? undefined : bodyRange(bodyValue)
const bodyValueIndex = bodyIndex !== -1 && !args[bodyIndex].startsWith("--body=") ? bodyIndex + 1 : -1
const file = args.find((arg, index) => !arg.startsWith("-") && index !== bodyValueIndex)
if (!file) {
  console.error("map: no file given")
  process.exit(1)
}

const source = Bun.file(file)
if (!(await source.exists())) {
  console.error(`map: ${file} does not exist`)
  process.exit(1)
}

const lines = (await source.text()).split(/\r?\n/)
const header = `# ${path.relative(process.cwd(), path.resolve(file)) || file} (${lines.length} lines)`

if (body) {
  const from = Math.max(1, body.from)
  const to = Math.min(lines.length, body.to)
  if (from > to) {
    console.error(`map: --body ${body.from}-${body.to} is outside the file`)
    process.exit(1)
  }
  console.log(`${header}:${from}-${to}`)
  const shown = lines.slice(from - 1, to)
  shown.slice(0, 300).forEach((line, index) => console.log(`${from + index}: ${line}`))
  if (shown.length > 300) console.log(`… ${shown.length - 300} more lines; ask for a smaller range`)
  process.exit(0)
}

const mapLimit = 60
const declarations = lines.flatMap((line, index) => {
  // A declaration the map cares about starts at column zero; anything indented lives in a body.
  if (!line || /^\s/.test(line)) return []
  const declaration = describe(line, lines, index)
  return declaration ? [`${index + 1}: ${declaration}`] : []
})

console.log(header)
if (declarations.length === 0) {
  console.log("  (no top-level declarations)")
  process.exit(0)
}
const shown = declarations.length > mapLimit - 1 ? declarations.slice(0, mapLimit - 2) : declarations
shown.forEach((declaration) => console.log(declaration))
if (declarations.length > shown.length)
  console.log(`… ${declarations.length - shown.length} more declarations (--body <line>-<line> to read one)`)
process.exit(0)

// `--body 120-150`, `--body 120-` and `--body 120` all mean the same thing: read from a line.
function bodyRange(value: string | undefined) {
  const match = /^(\d+)(?:-(\d+))?$/.exec((value ?? "").trim())
  if (!match) {
    console.error("map: --body wants a range such as 120-150")
    process.exit(1)
  }
  const from = Number(match[1])
  return { from, to: match[2] ? Number(match[2]) : from }
}

function describe(line: string, lines: string[], index: number) {
  const text = line.trim()
  if (/^(\/\/|\/\*|\*|\}|\]|\))/.test(text)) return undefined

  const selfExport = /^export\s+\*\s+as\s+([\w$]+)/.exec(text)
  if (selfExport) return `export namespace ${selfExport[1]}`

  const fn = /^(export\s+)?(default\s+)?(declare\s+)?(async\s+)?function\s*\*?\s*([\w$]+)/.exec(text)
  if (fn) return cutBody(readHeader(lines, index))

  const klass = /^(export\s+)?(default\s+)?(abstract\s+|declare\s+)*class\s+([\w$]+)/.exec(text)
  if (klass) return cutBody(readHeader(lines, index))

  const iface = /^(export\s+)?interface\s+([\w$]+)/.exec(text)
  if (iface) return cutBody(readHeader(lines, index)).replace(/\s*\{\s*$/, "")

  const shape = /^(export\s+)?(declare\s+)?(type|enum|namespace)\s+([\w$]+)/.exec(text)
  if (shape) return `${shape[1] ?? ""}${shape[3]} ${shape[4]}`

  const value = /^(export\s+)?(declare\s+)?(const|let|var)\s+([\w$]+)/.exec(text)
  if (value) return `${value[1] ?? ""}${value[3]} ${value[4]}`

  return undefined
}

// A signature often spans several lines; read on until the parameters close, then drop the body.
function readHeader(lines: string[], index: number) {
  const parts = [lines[index].trim()]
  const open = () => parts.join(" ").split("(").length - parts.join(" ").split(")").length
  while (open() > 0 && parts.length < 5 && index + parts.length < lines.length) parts.push(lines[index + parts.length].trim())
  return parts.join(" ").replace(/\s+/g, " ")
}

// The body starts at the first `{` outside parentheses: `function f({ a }: Options) {` must keep
// its destructured parameter, so a plain split on `{` would cut it in half.
function cutBody(header: string) {
  let depth = 0
  for (let index = 0; index < header.length; index++) {
    const character = header[index]
    if (character === "(") depth++
    if (character === ")") depth--
    if (depth === 0 && (character === "{" || character === ";")) {
      return trim(header.slice(0, index))
    }
  }
  return trim(header)
}

function trim(text: string) {
  const value = text.trim()
  return value.length > 120 ? `${value.slice(0, 119)}…` : value
}
