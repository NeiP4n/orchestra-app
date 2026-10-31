// Extraction of the declarations, imports and calls of one file.
//
// Imports come from Bun's own scanner, which understands every module syntax the runtime does. Symbols
// and calls come from the lightweight token stream in ./tokens.ts: a declaration is a keyword plus a
// name, and a call is a name followed by an opening parenthesis. Resolution of what a call points at is
// deliberately not attempted here; the graph resolves names at query time.

import { KEYWORDS, tokenize, type Token } from "./tokens.js"
import type { Edge, ExtractedFile, ImportedModule, Symbol, SymbolKind } from "./types.js"

const LOADERS: Record<string, "ts" | "tsx" | "js" | "jsx"> = {
  ".ts": "ts",
  ".mts": "ts",
  ".cts": "ts",
  ".tsx": "tsx",
  ".jsx": "tsx",
  ".js": "js",
  ".mjs": "js",
  ".cjs": "js",
}

const MODIFIERS = new Set([
  "abstract",
  "async",
  "declare",
  "default",
  "get",
  "override",
  "private",
  "protected",
  "public",
  "readonly",
  "set",
  "static",
])

const METHOD_MODIFIERS = new Set([
  "public",
  "private",
  "protected",
  "static",
  "async",
  "get",
  "set",
  "readonly",
  "override",
])

interface Entry {
  readonly symbol: Symbol
  /** Token index where the declaration starts. */
  readonly start: number
  /** Token index where the declaration ends, as far as the braces can tell. */
  readonly end: number
}

export function extractFile(path: string, source: string): ExtractedFile {
  const tokens = tokenize(source)
  const entries = collectSymbols(path, tokens)
  const declared = new Set(entries.map((entry) => `${entry.symbol.line}:${entry.symbol.column}`))
  const imports = scanImports(path, source)
  return {
    path,
    imports,
    symbols: entries.map((entry) => entry.symbol),
    edges: [
      ...imports.map((module) => ({
        src: path,
        dst: module.specifier,
        kind: "import" as const,
        path,
        line: module.line,
      })),
      ...collectCalls(path, tokens, entries, declared),
    ],
  }
}

function scanImports(path: string, source: string): ImportedModule[] {
  const extension = path.slice(path.lastIndexOf(".")).toLowerCase()
  // A file that does not parse must still contribute what the tokens can see, so a scanner failure
  // degrades to "no imports" instead of failing the whole index run.
  try {
    const scanned = new Bun.Transpiler({ loader: LOADERS[extension] ?? "ts" }).scan(source)
    return scanned.imports.map((item) => ({ specifier: item.path, line: lineOf(source, item.path) }))
  } catch {
    return []
  }
}

function lineOf(source: string, needle: string) {
  const at = source.indexOf(needle)
  if (at <= 0) return 1
  let line = 1
  for (let index = 0; index < at; index++) if (source[index] === "\n") line++
  return line
}

type BraceKind = "type" | "class" | "object" | "block"

function collectSymbols(path: string, tokens: Token[]): Entry[] {
  const entries: Entry[] = []
  const braces: BraceKind[] = []
  let classDepth: number | undefined
  let className: string | undefined
  let pending: { kind: "class" | "type"; name: string } | undefined
  let pendingLife = 0

  const push = (kind: SymbolKind, nameIndex: number, keywordIndex: number, container?: string) => {
    const name = tokens[nameIndex]!
    const block = blockEnd(tokens, nameIndex + 1)
    entries.push({
      symbol: {
        id: `${path}#${container ? `${container}.` : ""}${name.value}:${name.line}:${name.column}`,
        name: name.value,
        ...(container ? { container } : {}),
        kind,
        path,
        line: name.line,
        column: name.column,
        endLine: Math.max(block.endLine, name.line),
        exported: isExported(tokens, keywordIndex),
      },
      start: keywordIndex,
      end: block.end,
    })
  }

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!

    if (token.type === "punct") {
      if (token.value === "{") {
        const kind = pending?.kind ?? braceKind(tokens[index - 1])
        braces.push(kind)
        if (kind === "class" && pending?.kind === "class") {
          className = pending.name
          classDepth = braces.length
        }
        pending = undefined
        continue
      }
      if (token.value === "}") {
        const closed = braces.pop()
        if (closed === "class") {
          classDepth = undefined
          className = undefined
        }
        continue
      }
      // A declaration that never opens a brace (`type Mode = "a" | "b"`) must not lend its kind to
      // the next brace of the file.
      if (token.value === ";" && pending !== undefined) pending = undefined
      continue
    }

    if (token.type !== "word") continue
    const next = tokens[index + 1]
    const previous = tokens[index - 1]

    if (pending !== undefined && ++pendingLife > 20) pending = undefined

    if (token.value === "class" && next?.type === "word") {
      pending = { kind: "class", name: next.value }
      pendingLife = 0
      push("class", index + 1, index)
      continue
    }

    if (token.value === "interface" && next?.type === "word") {
      pending = { kind: "type", name: next.value }
      pendingLife = 0
      push("interface", index + 1, index)
      continue
    }

    if (token.value === "enum" && next?.type === "word") {
      pending = { kind: "type", name: next.value }
      pendingLife = 0
      push("enum", index + 1, index)
      continue
    }

    // `import type { ... }` has a brace after `type`, not a name, so it never reaches here.
    if (token.value === "type" && next?.type === "word" && tokens[index + 2]?.value === "=") {
      pending = { kind: "type", name: next.value }
      pendingLife = 0
      push("type", index + 1, index)
      continue
    }

    if (token.value === "function") {
      const star = tokens[index + 1]?.value === "*" ? 1 : 0
      const name = tokens[index + 1 + star]
      if (name?.type === "word") push("function", index + 1 + star, index)
      continue
    }

    if (token.value === "const" || token.value === "let" || token.value === "var") {
      if (next?.type !== "word") continue
      push(arrowFunction(tokens, index + 1) ? "function" : "variable", index + 1, index)
      continue
    }

    const atMemberPosition =
      previous === undefined ||
      (previous.type === "punct" &&
        (previous.value === "{" || previous.value === "," || previous.value === "}" || previous.value === ";")) ||
      (previous.type === "word" && METHOD_MODIFIERS.has(previous.value))

    // A name followed by `(` at class-body depth is a method, unless a modifier sits in front of it.
    if (className !== undefined && braces.length === classDepth && next?.value === "(" && atMemberPosition) {
      push("method", index, index, className)
      continue
    }

    // An object literal keeps its behaviour in properties: `createSociety: Effect.fn(...)(function* () {})`
    // is the shape this repository uses everywhere, and it is a declaration like any other.
    if (braces.at(-1) !== "object" || !atMemberPosition) continue
    if (next?.value === "(") push("method", index, index)
    // `sent: Date.now()` holds a value, not behaviour, so only a property whose range carries a
    // function body is a declaration worth an entry.
    else if (next?.value === ":") {
      const block = blockEnd(tokens, index + 1)
      if (containsFunction(tokens, index + 2, block.end)) push("method", index, index)
    }
  }

  return entries
}

// What a brace belongs to decides whether its members are declarations: a type literal lists types, an
// object literal lists behaviour.
function braceKind(previous: Token | undefined): BraceKind {
  if (previous === undefined) return "block"
  if (previous.type === "word") return previous.value === "return" ? "object" : "block"
  if (
    previous.value === "=" ||
    previous.value === "(" ||
    previous.value === "," ||
    previous.value === ":" ||
    previous.value === "[" ||
    previous.value === "?"
  )
    return "object"
  if (previous.value === "=>") return "block"
  return "block"
}

// Whether the range carries a body at all: a property that only holds a call result declares nothing.
function containsFunction(tokens: Token[], from: number, to: number): boolean {
  for (let index = from; index <= to && index < tokens.length; index++) {
    const token = tokens[index]!
    if (token.value === "function" || token.value === "=>") return true
  }
  return false
}

function collectCalls(path: string, tokens: Token[], entries: Entry[], declared: Set<string>): Edge[] {
  const edges: Edge[] = []
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!
    if (token.type !== "word") continue
    if (tokens[index + 1]?.value !== "(") continue
    if (KEYWORDS.has(token.value)) continue
    if (declared.has(`${token.line}:${token.column}`)) continue
    const owner = ownerOf(entries, index)
    // A call outside every declaration still belongs to the file: the HTTP handler that starts a
    // Society is written exactly like that.
    edges.push({ src: owner?.symbol.id ?? path, dst: token.value, kind: "call", path, line: token.line })
  }
  return edges
}

// The innermost declaration that contains a token owns everything written inside it. A variable is not
// a container: a call in `const x = foo()` belongs to the function around it, not to `x`.
function ownerOf(entries: Entry[], index: number): Entry | undefined {
  let best: Entry | undefined
  for (const entry of entries) {
    if (entry.symbol.kind === "variable") continue
    if (entry.start > index || entry.end < index) continue
    if (best === undefined || entry.end - entry.start < best.end - best.start) best = entry
  }
  return best
}

function isExported(tokens: Token[], keywordIndex: number) {
  for (let index = keywordIndex - 1; index >= 0; index--) {
    const token = tokens[index]!
    if (token.type !== "word") return false
    if (token.value === "export") return true
    if (!MODIFIERS.has(token.value)) return false
  }
  return false
}

// `const x = <value>`: the value is an arrow function, a function expression or a generic arrow.
function arrowFunction(tokens: Token[], nameIndex: number): boolean {
  let index = nameIndex + 1
  let parens = 0
  while (index < tokens.length && index < nameIndex + 40) {
    const token = tokens[index]!
    if (token.type === "punct") {
      if (token.value === "(") parens++
      else if (token.value === ")") parens--
      else if (token.value === "=" && parens === 0) return valueIsFunction(tokens, index + 1)
      else if (parens === 0 && (token.value === ";" || token.value === "{")) return false
    }
    index++
  }
  return false
}

function valueIsFunction(tokens: Token[], start: number): boolean {
  let index = start
  if (tokens[index]?.value === "async") index++
  if (tokens[index]?.value === "function") return true
  if (tokens[index]?.value === "<") {
    while (index < tokens.length && tokens[index]!.value !== ">") index++
    index++
  }
  const token = tokens[index]
  if (!token) return false
  if (token.type === "word") return tokens[index + 1]?.value === "=>"
  if (token.value !== "(") return false

  // A parenthesised parameter list, then `=>` possibly after a return type annotation.
  let parens = 0
  for (; index < tokens.length; index++) {
    const current = tokens[index]!
    if (current.value === "(") parens++
    else if (current.value === ")") {
      parens--
      if (parens === 0) {
        index++
        break
      }
    }
  }
  for (let cursor = index; cursor < tokens.length && cursor < index + 20; cursor++) {
    const current = tokens[cursor]!
    if (current.value === "=>") return true
    if (current.value === ";" || current.value === "{" || current.value === "}") return false
  }
  return false
}

// The end of a declaration: the statement terminator, or the matching brace of its body. A brace that
// opens a function body inside a call (`Effect.fn(...)(function* (input) {`) is the body too, while a
// brace passed as an argument (`foo({ a: 1 })`) belongs to the argument and is skipped.
function blockEnd(tokens: Token[], from: number): { end: number; endLine: number } {
  let index = from
  let parens = 0
  while (index < tokens.length) {
    const token = tokens[index]!
    if (token.type === "punct") {
      if (token.value === "(") parens++
      else if (token.value === ")") {
        parens--
        if (parens < 0) return { end: index, endLine: token.line }
      } else if (token.value === ";") {
        if (parens === 0) return { end: index, endLine: token.line }
      } else if (token.value === "}") {
        if (parens <= 0) return { end: index, endLine: token.line }
      } else if (token.value === "{") {
        const previous = tokens[index - 1]
        const body =
          previous !== undefined && previous.type === "punct" && (previous.value === ")" || previous.value === "=>")
        if (parens === 0 || body) break
      }
    }
    index++
  }
  if (index >= tokens.length) return { end: tokens.length - 1, endLine: tokens.at(-1)?.line ?? 0 }

  let depth = 0
  for (let cursor = index; cursor < tokens.length; cursor++) {
    const token = tokens[cursor]!
    if (token.type !== "punct") continue
    if (token.value === "{") depth++
    else if (token.value === "}") {
      depth--
      if (depth === 0) return { end: cursor, endLine: token.line }
    }
  }
  return { end: tokens.length - 1, endLine: tokens.at(-1)?.line ?? 0 }
}
