// A deliberately small lexer. It produces identifiers, numbers and single punctuation characters with
// their positions, and throws away everything that cannot be a declaration or a call: comments, string
// literals, template literals and regular expression literals.
//
// It is not a parser: a template literal is skipped as one opaque literal, so an expression inside
// `${...}` is not tokenized. That loses calls inside template interpolation and nothing else, which is
// the right trade for a graph that must index files it cannot fully parse.

export interface Token {
  readonly value: string
  readonly type: "word" | "punct" | "number"
  /** 1-based. */
  readonly line: number
  /** 1-based. */
  readonly column: number
}

/** Words that introduce syntax rather than name a callable. */
export const KEYWORDS = new Set([
  "as",
  "async",
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "declare",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "from",
  "function",
  "get",
  "if",
  "implements",
  "import",
  "in",
  "instanceof",
  "interface",
  "keyof",
  "let",
  "new",
  "null",
  "of",
  "private",
  "protected",
  "public",
  "readonly",
  "return",
  "satisfies",
  "set",
  "static",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "type",
  "typeof",
  "undefined",
  "var",
  "void",
  "while",
  "with",
  "yield",
])

const WHITESPACE = new Set([" ", "\t", "\r", "\f", "\v"])
const REGEX_PRECEDERS = new Set([
  "(",
  ",",
  "=",
  ":",
  "[",
  "!",
  "&",
  "|",
  "?",
  "{",
  "}",
  ";",
  "+",
  "-",
  "*",
  "%",
  "<",
  ">",
  "~",
  "^",
])

export function tokenize(source: string): Token[] {
  const tokens: Token[] = []
  let index = 0
  let line = 1
  let column = 1

  const advance = (count: number) => {
    for (let offset = 0; offset < count; offset++) {
      if (source[index + offset] === "\n") {
        line++
        column = 1
        continue
      }
      column++
    }
    index += count
  }

  while (index < source.length) {
    const char = source[index]!

    if (char === "\n" || WHITESPACE.has(char)) {
      advance(1)
      continue
    }

    if (char === "/" && source[index + 1] === "/") {
      const end = source.indexOf("\n", index)
      advance(end === -1 ? source.length - index : end - index)
      continue
    }

    if (char === "/" && source[index + 1] === "*") {
      const end = source.indexOf("*/", index + 2)
      advance(end === -1 ? source.length - index : end + 2 - index)
      continue
    }

    if (char === "'" || char === '"' || char === "`") {
      advance(skipString(source, index, char))
      continue
    }

    if (char === "/" && startsRegex(tokens)) {
      advance(skipRegex(source, index))
      continue
    }

    // The fat arrow is the one multi-character operator the extractor has to see whole.
    if (char === "=" && source[index + 1] === ">") {
      tokens.push({ value: "=>", type: "punct", line, column })
      advance(2)
      continue
    }

    if (isDigit(char)) {
      let length = 1
      while (index + length < source.length && /[0-9A-Za-z._]/.test(source[index + length]!)) length++
      tokens.push({ value: source.slice(index, index + length), type: "number", line, column })
      advance(length)
      continue
    }

    if (isWordStart(char)) {
      let length = 1
      while (index + length < source.length && isWordPart(source[index + length]!)) length++
      tokens.push({ value: source.slice(index, index + length), type: "word", line, column })
      advance(length)
      continue
    }

    tokens.push({ value: char, type: "punct", line, column })
    advance(1)
  }

  return tokens
}

// A regex literal can only start where an expression may start, so the previous token decides whether
// a slash divides two values or opens a pattern.
function startsRegex(tokens: Token[]): boolean {
  const previous = tokens.at(-1)
  if (!previous) return true
  if (previous.type === "word") return KEYWORDS.has(previous.value) && previous.value !== "this"
  if (previous.type === "number") return false
  return REGEX_PRECEDERS.has(previous.value)
}

function skipString(source: string, start: number, quote: string): number {
  let index = start + 1
  while (index < source.length) {
    const char = source[index]!
    if (char === "\\") {
      index += 2
      continue
    }
    if (char === quote) return index + 1 - start
    index++
  }
  return source.length - start
}

function skipRegex(source: string, start: number): number {
  let index = start + 1
  let characterClass = false
  while (index < source.length) {
    const char = source[index]!
    if (char === "\\") {
      index += 2
      continue
    }
    if (char === "\n") return index - start
    if (char === "[") characterClass = true
    else if (char === "]") characterClass = false
    else if (char === "/" && !characterClass) {
      let end = index + 1
      while (end < source.length && /[a-z]/.test(source[end]!)) end++
      return end - start
    }
    index++
  }
  return source.length - start
}

function isDigit(char: string) {
  return char >= "0" && char <= "9"
}

function isWordStart(char: string) {
  return (char >= "a" && char <= "z") || (char >= "A" && char <= "Z") || char === "_" || char === "$"
}

function isWordPart(char: string) {
  return isWordStart(char) || isDigit(char)
}
