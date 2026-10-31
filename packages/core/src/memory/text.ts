const RU = [
  "овать",
  "евать",
  "ивать",
  "ывать",
  "вшись",
  "вший",
  "вшая",
  "вшее",
  "вшие",
  "нием",
  "ниям",
  "ного",
  "ному",
  "ными",
  "ным",
  "ном",
  "ный",
  "ная",
  "ное",
  "ные",
  "ную",
  "ую",
  "юю",
  "ых",
  "их",
  "ает",
  "яет",
  "ует",
  "ал",
  "ил",
  "ия",
  "ие",
  "ий",
  "ию",
  "ого",
  "ему",
  "ыми",
  "ями",
  "ами",
  "ей",
  "ой",
  "ий",
  "ый",
  "ая",
  "яя",
  "ое",
  "ее",
  "ые",
  "ов",
  "ев",
  "ах",
  "ях",
  "ам",
  "ям",
  "ом",
  "ем",
  "ть",
  "а",
  "я",
  "о",
  "е",
  "ы",
  "и",
  "у",
  "ю",
  "ь",
]

const EN = [
  "ations",
  "ation",
  "ments",
  "ment",
  "ings",
  "ing",
  "ies",
  "ied",
  "ers",
  "er",
  "ed",
  "es",
  "ly",
  "s",
]

export const STOP = new Set([
  "the",
  "and",
  "or",
  "of",
  "to",
  "in",
  "on",
  "for",
  "is",
  "are",
  "be",
  "it",
  "this",
  "that",
  "with",
  "as",
  "at",
  "by",
  "an",
  "и",
  "в",
  "во",
  "на",
  "не",
  "что",
  "как",
  "это",
  "по",
  "из",
  "за",
  "от",
  "до",
  "для",
  "же",
  "ли",
  "бы",
  "но",
  "а",
  "или",
  "то",
  "так",
  "уже",
  "с",
  "со",
  "к",
  "ко",
  "о",
  "об",
  "обо",
  "у",
  "мы",
  "вы",
  "он",
  "она",
  "они",
  "я",
  "его",
  "ее",
  "их",
  "ему",
  "ей",
  "им",
])

export function stemRU(word: string): string {
  if (word.length <= 3) return word
  for (const ending of RU) {
    if (word.endsWith(ending) && word.length - ending.length >= 3) {
      return word.slice(0, -ending.length)
    }
  }
  return word
}

export function stemEN(word: string): string {
  if (word.length <= 3) return word
  for (const ending of EN) {
    if (word.endsWith(ending) && word.length - ending.length >= 3) {
      return word.slice(0, -ending.length)
    }
  }
  return word
}

export function stem(word: string): string {
  const lower = word.toLowerCase()
  if (/^[\u0400-\u04FF]+$/.test(lower)) {
    return stemRU(lower)
  }
  if (/^[a-z]+$/.test(lower)) {
    return stemEN(lower)
  }
  return lower
}

export function normalize(text: string): string {
  return text.toLowerCase().trim()
}

export function tokenize(text: string): string[] {
  const matches = text.toLowerCase().match(/[\p{L}\p{N}]+/gu)
  if (!matches) return []
  return matches
}

export function extractTerms(text: string): Map<string, number> {
  const tokens = tokenize(text)
  const map = new Map<string, number>()
  for (const token of tokens) {
    if (token.length <= 1) continue
    if (STOP.has(token)) continue
    const s = stem(token)
    if (s.length <= 1) continue
    map.set(s, (map.get(s) ?? 0) + 1)
  }
  return map
}

export function trigrams(text: string): string[] {
  const normalized = "  " + normalize(text) + "  "
  if (normalized.length < 3) return []
  const list: string[] = []
  for (let i = 0; i <= normalized.length - 3; i++) {
    list.push(normalized.slice(i, i + 3))
  }
  return list
}

export function trigramSimilarity(a: string, b: string): number {
  const setA = new Set(trigrams(a))
  const setB = new Set(trigrams(b))
  if (setA.size === 0 && setB.size === 0) return 1
  if (setA.size === 0 || setB.size === 0) return 0
  let inter = 0
  for (const tri of setA) {
    if (setB.has(tri)) inter++
  }
  const union = setA.size + setB.size - inter
  return inter / union
}
