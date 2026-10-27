export * as BudgetGuard from "./budget.js"

export interface BudgetEnforcementResult {
  readonly text: string
  readonly truncated: boolean
  readonly estimatedTokens: number
}

export interface BudgetGuardOptions {
  readonly truncationMarker?: string
}

const DEFAULT_TRUNCATION_MARKER = "\n<!-- [Truncated: context budget limit reached] -->"

/**
 * Fast, allocation-conscious token estimator across ASCII letters, Cyrillic,
 * numbers, and code syntax / punctuation.
 */
export function estimatePromptTokens(text: string): number {
  if (!text) return 0

  let asciiWordChars = 0
  let cyrillicChars = 0
  let codeAndPunct = 0
  let digits = 0
  let otherChars = 0

  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    // ASCII letters and whitespace
    if (
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      code === 32 ||
      code === 9 ||
      code === 10 ||
      code === 13
    ) {
      asciiWordChars++
    } else if (code >= 1024 && code <= 1279) {
      // Cyrillic range \u0400 - \u04FF
      cyrillicChars++
    } else if (code >= 48 && code <= 57) {
      // Digits 0-9
      digits++
    } else if (
      (code >= 33 && code <= 47) ||
      (code >= 58 && code <= 64) ||
      (code >= 91 && code <= 96) ||
      (code >= 123 && code <= 126)
    ) {
      // Code syntax & punctuation: {}[]()<>;:=+-/*%&|^!~`"'.,?
      codeAndPunct++
    } else {
      otherChars++
    }
  }

  const rawEstimate =
    asciiWordChars / 4.0 +
    cyrillicChars / 1.8 +
    codeAndPunct / 1.5 +
    digits / 2.2 +
    otherChars / 1.5

  return Math.max(1, Math.ceil(rawEstimate))
}

const VOID_TAGS = new Set(["br", "hr", "img", "input", "meta", "link"])
const TAG_REGEX = /<\/?([a-zA-Z0-9_\-:]+)(?:\s+[^>]*?)?(\/?)>/g

/**
 * Extracts unclosed XML/HTML tags in a given text slice to preserve block integrity.
 */
function findUnclosedTags(text: string): string[] {
  const openTags: string[] = []
  let match: RegExpExecArray | null

  // Reset regex index
  TAG_REGEX.lastIndex = 0
  while ((match = TAG_REGEX.exec(text)) !== null) {
    const full = match[0]
    const tagName = match[1]!.toLowerCase()
    const isSelfClosing = match[2] === "/" || full.endsWith("/>") || VOID_TAGS.has(tagName)
    const isClosing = full.startsWith("</")

    if (isSelfClosing) {
      continue
    }

    if (isClosing) {
      const lastIndex = openTags.lastIndexOf(tagName)
      if (lastIndex !== -1) {
        openTags.splice(lastIndex, 1)
      }
    } else {
      openTags.push(tagName)
    }
  }

  return openTags
}

/**
 * Checks if markdown code fence block (```) is unclosed.
 */
function isCodeFenceUnclosed(text: string): boolean {
  const lines = text.split("\n")
  let fenceCount = 0
  for (const line of lines) {
    if (line.trimStart().startsWith("```")) {
      fenceCount++
    }
  }
  return fenceCount % 2 !== 0
}

/**
 * Enforces a token budget on instructions, cleanly truncating excess content
 * while strictly preserving XML and Markdown structure and tag balance.
 */
export function enforceBudget(
  instructions: string,
  maxTokens: number,
  options?: BudgetGuardOptions,
): BudgetEnforcementResult {
  const initialEstimate = estimatePromptTokens(instructions)
  if (initialEstimate <= maxTokens || maxTokens <= 0) {
    return {
      text: instructions,
      truncated: false,
      estimatedTokens: initialEstimate,
    }
  }

  const marker = options?.truncationMarker ?? DEFAULT_TRUNCATION_MARKER
  const markerTokens = estimatePromptTokens(marker)
  const targetTokens = Math.max(1, maxTokens - markerTokens)

  const lines = instructions.split("\n")
  const includedLines: string[] = []

  for (let i = 0; i < lines.length; i++) {
    includedLines.push(lines[i]!)
    const currentText = includedLines.join("\n")
    if (estimatePromptTokens(currentText) > targetTokens) {
      // Remove the line that pushed us over budget
      includedLines.pop()
      break
    }
  }

  const buildResult = (baseLines: string[]): string => {
    let slice = baseLines.join("\n")

    // 1. Balance code fences
    if (isCodeFenceUnclosed(slice)) {
      slice += "\n```"
    }

    // 2. Balance unclosed XML tags in reverse order
    const unclosed = findUnclosedTags(slice)
    if (unclosed.length > 0) {
      for (let i = unclosed.length - 1; i >= 0; i--) {
        slice += `\n</${unclosed[i]}>`
      }
    }

    // 3. Append truncation marker
    slice += marker
    return slice
  }

  let result = buildResult(includedLines)

  // In case auto-closing tags and marker exceeded maxTokens, step back lines
  while (includedLines.length > 0 && estimatePromptTokens(result) > maxTokens) {
    includedLines.pop()
    result = buildResult(includedLines)
  }

  return {
    text: result,
    truncated: true,
    estimatedTokens: estimatePromptTokens(result),
  }
}
