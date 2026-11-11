export * as McpSelect from "./select.js"

import { McpCatalog } from "./catalog.js"
import { McpRatings } from "./ratings.js"

// Smart MCP selection: rank catalog servers by the task's need, in code —
// not by guessing the first token match. The old `select()` matched English
// tokens against the catalog and took `matches[0]`; a need phrased in
// Russian matched nothing at all, and a need matching two servers equally
// was decided by sort order. This module:
//
// - translates Russian capability words to English before matching, so
//   "автоматизация браузера" uses native browser tools and "документация библиотеки"
//   finds Context7;
// - ranks every candidate with a confidence score, and says so in the
//   explanation (rank + fallback), instead of silently picking one;
// - refuses to guess below the confidence threshold or on a tie at the top:
//   it returns an ask-card (candidates + recommendation) for the
//   Orchestrator to answer with an explicit server id;
// - walks a fallback chain when the winner is down (context7 → deepwiki,
//   serena → native symbols/grep, retired browsers → native browser) instead of
//   hammering the dead server;
// - answers needs a native tool already covers (web search, memory, git,
//   time, ...) with the native analogue, not with a catalog server;
// - lets persistent server ratings (./ratings.ts) nudge the ranking: a
//   proven server outranks an untried one on an otherwise equal score.

// ---------------------------------------------------------------------------
// Russian → English
// ---------------------------------------------------------------------------

/** Whole-phrase translations first: a phrase means more than its words ("поиск по коду" is code search, not web search). */
const PHRASES: Readonly<Record<string, string>> = {
  "поиск по коду": "code symbols references",
  "поиск кода": "code symbols",
  "найти в коде": "code symbols references",
  "автоматизация браузера": "browser automation",
  "открыть сайт": "browser navigate website",
  "зайти на сайт": "browser navigate website",
  "открыть страницу": "browser navigate website",
  "сделать скриншот": "browser screenshot",
  "документация библиотеки": "documentation library",
  "документация по библиотеке": "documentation library",
  "ошибка в проде": "production errors",
  "ошибка продакшн": "production errors",
  "продакшн ошибка": "production errors",
  "разобрать бинарник": "reverse binary",
  "понять репозиторий": "repository documentation",
  "репозиторий на гитхабе": "github repository",
  "пошаговое мышление": "thinking sequential steps",
  "трекер задач": "task tracker board",
  "база данных": "database sql",
  "запомнить это": "memory remember",
  "на будущее": "memory remember",
}

const RU_TRANSLATIONS: Readonly<Record<string, string>> = {
  браузер: "browser",
  браузера: "browser",
  браузере: "browser",
  автоматизация: "automation",
  автоматизировать: "automation",
  документация: "documentation",
  документации: "documentation",
  доки: "documentation",
  библиотека: "library",
  библиотеки: "library",
  библиотек: "library",
  репозиторий: "repository",
  репозитория: "repository",
  репозитории: "repository",
  гитхаб: "github",
  гитхаба: "github",
  код: "code",
  кода: "code",
  коде: "code",
  символы: "symbols",
  символ: "symbol",
  поиск: "search",
  найти: "search",
  ошибки: "errors",
  ошибка: "error",
  ошибок: "errors",
  продакшн: "production",
  прод: "production",
  десктоп: "desktop",
  приложение: "application",
  приложения: "application",
  приложением: "application",
  реверс: "reverse",
  бинарник: "binary",
  задачи: "tasks",
  задача: "task",
  трекер: "tracker",
  память: "memory",
  запомнить: "remember",
  помнить: "remember",
  заметка: "note",
  заметки: "notes",
  мышление: "thinking",
  история: "history",
  истории: "history",
  историю: "history",
  коммит: "commit",
  коммитов: "commit",
  коммиты: "commit",
  сегодня: "today",
  число: "date",
  файлы: "files",
  файловая: "filesystem",
  файл: "file",
  база: "database",
  данных: "database",
  время: "time",
  дата: "date",
  интернет: "web",
  веб: "web",
  сайт: "website",
  страница: "website",
  страницами: "website",
  скриншот: "screenshot",
  клик: "click",
  кликнуть: "click",
  открыть: "navigate",
  зайти: "navigate",
  скачать: "download",
  тестирование: "testing",
  тесты: "testing",
}

/** English synonyms used for matching only: one idea, several words ("code" also means symbols and references for Serena). */
const SYNONYMS: Readonly<Record<string, readonly string[]>> = {
  code: ["code", "symbols", "symbol", "references", "declarations"],
  search: ["search", "grep", "symbols"],
  browser: ["browser", "navigate", "screenshot", "click"],
  documentation: ["documentation", "docs"],
  library: ["library", "libraries"],
  errors: ["errors", "error"],
  error: ["error", "errors"],
  repository: ["repository", "repo"],
  file: ["file", "files"],
  files: ["files", "file"],
}

const tokens = (text: string) => [
  ...new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((token) => token.length > 2),
  ),
]

/** Light plural variants so "library" meets "libraries" and "errors" meets "error". */
const variants = (token: string): ReadonlySet<string> => {
  const out = new Set([token])
  if (token.length > 3 && token.endsWith("s")) out.add(token.slice(0, -1))
  if (!token.endsWith("s")) out.add(`${token}s`)
  if (token.endsWith("ies")) out.add(`${token.slice(0, -3)}y`)
  if (token.endsWith("y")) out.add(`${token.slice(0, -1)}ies`)
  return out
}

const expanded = (token: string): ReadonlySet<string> => {
  const out = new Set<string>()
  for (const synonym of SYNONYMS[token] ?? [token]) for (const variant of variants(synonym)) out.add(variant)
  return out
}

/** Translate a need (Russian, English, or mixed) into the English tokens the catalog is matched against. */
export function translateNeed(need: string): readonly string[] {
  let text = ` ${need.toLowerCase()} `
  for (const [phrase, english] of Object.entries(PHRASES)) {
    if (text.includes(` ${phrase} `)) text = text.replaceAll(` ${phrase} `, ` ${english} `)
  }
  const translated = tokens(text).map((token) => RU_TRANSLATIONS[token] ?? token)
  return [...new Set(translated)]
}

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

export interface Match {
  readonly entry: McpCatalog.Entry
  readonly score: number
  readonly reasons: readonly string[]
  /** 0..1: how strongly the need points at this server (see `confidence`). */
  readonly confidence: number
}

/** Confidence from the match itself: a name hit, a topical description hit, or several distinct tokens. */
export function confidence(score: number, distinct: number): number {
  return Math.min(0.95, 0.35 + 0.1 * score + 0.1 * distinct)
}

/**
 * Rank catalog servers for a need. Scores name/id matches above description
 * and usage text; ties break by id so the same need always ranks the same
 * way. A single generic word is not evidence: an entry qualifies when a
 * token hits its name/id, when at least two distinct tokens match, when
 * the weighted score reaches 4, or when a matched token is discriminating
 * (it appears in at most a quarter of the catalog) in the description or
 * name. Ratings nudge the score by up to ±1 (see ./ratings.ts), never
 * enough to qualify a server the need does not name.
 */
export function rank(
  need: string,
  platform: NodeJS.Platform = process.platform,
  ratings?: ReadonlyMap<string, McpRatings.Rating>,
  disabled: ReadonlySet<string> = new Set(),
): readonly Match[] {
  const wanted = translateNeed(need)
  if (wanted.length === 0) return []
  // Browser work must not rediscover another MCP browser through a generic desktop fallback.
  const documentation = wanted.some((token) => ["documentation", "docs", "library", "libraries"].includes(token))
  if (!documentation && matchNative(need).some((match) => match.analogue.id === "browser")) return []
  const entries = McpCatalog.forPlatform(platform).filter((entry) => !disabled.has(entry.id))
  const frequency = new Map<string, number>()
  for (const entry of entries)
    for (const token of tokens(`${entry.id} ${entry.name} ${entry.description} ${entry.usage}`))
      frequency.set(token, (frequency.get(token) ?? 0) + 1)
  const discriminating = (token: string) => (frequency.get(token) ?? 0) <= Math.max(2, Math.ceil(entries.length / 4))
  return entries
    .flatMap((entry) => {
      const fields: ReadonlyArray<readonly [string, number, boolean]> = [
        [`${entry.id} ${entry.name}`, 3, true],
        [entry.description, 2, false],
        [entry.usage, 1, false],
      ]
      let score = 0
      let named = false
      let topical = false
      const reasons: string[] = []
      for (const token of wanted) {
        const forms = expanded(token)
        for (const [text, weight, isName] of fields) {
          if (tokens(text).some((fieldToken) => forms.has(fieldToken))) {
            score += weight
            if (isName) named = true
            if (weight >= 2 && discriminating(token)) topical = true
            reasons.push(token)
            break
          }
        }
      }
      const distinct = new Set(reasons).size
      if (!(named || topical || distinct >= 2 || score >= 4)) return []
      const boosted = score + McpRatings.adjustment(ratings?.get(entry.id))
      return [{ entry, score: boosted, reasons: [...new Set(reasons)], confidence: confidence(boosted, distinct) }]
    })
    .toSorted((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id))
}

// ---------------------------------------------------------------------------
// Native analogues
// ---------------------------------------------------------------------------

export interface NativeMatch {
  readonly analogue: McpCatalog.NativeAnalogue
  /** Distinct need tokens that name this class. */
  readonly hits: readonly string[]
}

/** Which native classes the need names (distinct keyword hits; one hit qualifies only when the keyword belongs to this class alone). */
export function matchNative(need: string): readonly NativeMatch[] {
  const wanted = translateNeed(need)
  if (wanted.length === 0) return []
  const frequency = new Map<string, number>()
  for (const analogue of McpCatalog.nativeAnalogues)
    for (const keyword of analogue.keywords) frequency.set(keyword, (frequency.get(keyword) ?? 0) + 1)
  return McpCatalog.nativeAnalogues
    .flatMap((analogue) => {
      // Plain variant matching here, no synonym expansion: synonyms are for
      // catalog English text ("code" also means symbols), but a native class
      // must be named by its own words — "symbols" must not drag in web
      // search through the "search" synonym.
      const matched = (token: string, keyword: string) => variants(token).has(keyword) || variants(keyword).has(token)
      const hits = wanted.filter((token) => analogue.keywords.some((keyword) => matched(token, keyword)))
      const unique = hits.filter((token) =>
        analogue.keywords.some((keyword) => matched(token, keyword) && (frequency.get(keyword) ?? 0) <= 1),
      )
      if (hits.length >= 2 || unique.length >= 1) return [{ analogue, hits: [...new Set(hits)] }]
      return []
    })
    .toSorted((a, b) => b.hits.length - a.hits.length || a.analogue.id.localeCompare(b.analogue.id))
}

// ---------------------------------------------------------------------------
// Fallbacks and the decision
// ---------------------------------------------------------------------------

export type Fallback =
  | { readonly kind: "mcp"; readonly server: string }
  | { readonly kind: "native"; readonly tools: readonly string[] }

/**
 * What to try when the winner is down. A fallback is never a guess: the
 * chain is fixed per server, and the caller reports which link served.
 * `serena` and `xerj` are the two semantic-code servers in the catalog, so
 * they fall back to each other first, then to the native tools they wrap
 * (symbols/grep).
 */
export const FALLBACKS: Readonly<Record<string, readonly Fallback[]>> = {
  context7: [{ kind: "mcp", server: "deepwiki" }],
  deepwiki: [{ kind: "mcp", server: "context7" }],
  serena: [
    { kind: "mcp", server: "xerj" },
    { kind: "native", tools: ["symbols", "grep", "read"] },
  ],
  xerj: [
    { kind: "mcp", server: "serena" },
    { kind: "native", tools: ["symbols", "grep", "read"] },
  ],
  playwright: [{ kind: "native", tools: ["browser", "playtest"] }],
  "chrome-devtools": [{ kind: "native", tools: ["browser", "playtest"] }],
  "agent-desktop": [{ kind: "native", tools: ["desktop", "playtest"] }],
  github: [{ kind: "native", tools: ["shell"] }],
  sentry: [],
  "rea-anything": [],
}

export const fallbackChain = (server: string): readonly Fallback[] => FALLBACKS[server] ?? []

/** Below this confidence the selector asks instead of guessing. */
export const CONFIDENCE_THRESHOLD = 0.5

export interface ChoiceCard {
  readonly key: string
  readonly kind: "ask"
  readonly title: string
  readonly text: string
  readonly options: readonly string[]
  readonly recommend: string | null
  readonly about: string
}

export type Decision =
  | {
      readonly kind: "mcp"
      readonly server: string
      readonly chain: readonly Fallback[]
      readonly confidence: number
      readonly reasons: readonly string[]
      readonly explanation: string
      readonly ranked: readonly Match[]
    }
  | {
      readonly kind: "native"
      readonly analogue: McpCatalog.NativeAnalogue
      readonly hits: readonly string[]
      readonly explanation: string
    }
  | {
      readonly kind: "ask"
      readonly candidates: readonly Match[]
      readonly nativeCandidates: readonly NativeMatch[]
      readonly confidence: number
      readonly explanation: string
      readonly card: ChoiceCard
    }

/** The ask-card for a need nobody could decide: candidates, a recommendation when there is one, and the explicit choice the Orchestrator owes. */
export function buildChoiceCard(
  need: string,
  candidates: readonly Match[],
  nativeCandidates: readonly NativeMatch[],
): ChoiceCard {
  const best = candidates[0]
  const options = [
    ...candidates.map((match) => match.entry.id),
    ...nativeCandidates.map((match) => `native:${match.analogue.id} (${match.analogue.nativeTools.join(", ")})`),
  ]
  return {
    key: `mcp-choice:${need.slice(0, 80)}`,
    kind: "ask",
    title: `Which MCP server fits: "${need}"?`,
    text: [
      `No server fits "${need}" confidently enough to pick alone.`,
      ...(candidates.length > 0
        ? [
            `Closest servers: ${candidates.map((match) => `${match.entry.id} (score ${match.score}, ${match.reasons.join(", ")})`).join("; ")}.`,
          ]
        : ["No catalog server matches the need."]),
      ...(nativeCandidates.length > 0
        ? [
            `Native tools already cover it: ${nativeCandidates.map((match) => `${match.analogue.id} (${match.analogue.nativeTools.join(", ")})`).join("; ")}.`,
          ]
        : []),
      "Answer with an explicit server id (mcp_manager acquire with server), or a native tool — do not guess.",
    ].join(" "),
    options: options.length > 0 ? options : ["none: use native tools only"],
    recommend: best ? best.entry.id : null,
    about: "mcp-select",
  }
}

export interface SelectOptions {
  readonly disabled?: ReadonlySet<string>
  readonly platform?: NodeJS.Platform
  /** Persistent ratings to nudge the ranking; absent means no history yet. */
  readonly ratings?: ReadonlyMap<string, McpRatings.Rating>
}

/**
 * Decide what serves a need: the best catalog server with its fallback
 * chain, a native analogue, or an ask-card. A native analogue wins only
 * when it names the need at least as specifically as the best server
 * (more distinct keyword hits); a server the need names wins over a
 * native class it merely mentions. A tie at the top between two servers,
 * or a winner below the confidence threshold, is an ask — never a guess.
 */
export function selectForTask(need: string, options: SelectOptions = {}): Decision {
  const ranked = rank(need, options.platform, options.ratings, options.disabled)
  const native = matchNative(need)
  const best = ranked[0]
  const bestNative = native[0]
  if (bestNative && (!best || bestNative.hits.length > new Set(best.reasons).size)) {
    return {
      kind: "native",
      analogue: bestNative.analogue,
      hits: bestNative.hits,
      explanation: `No catalog server needed: "${need}" is covered by native tools (${bestNative.analogue.nativeTools.join(", ")}).`,
    }
  }
  if (!best) {
    return {
      kind: "ask",
      candidates: ranked,
      nativeCandidates: native,
      confidence: 0,
      explanation: `No catalog server matches "${need}"${native.length > 0 ? "; native tools may cover it" : ""}.`,
      card: buildChoiceCard(need, ranked, native),
    }
  }
  const second = ranked[1]
  if (best.confidence < CONFIDENCE_THRESHOLD || (second && second.score >= best.score)) {
    return {
      kind: "ask",
      candidates: ranked,
      nativeCandidates: native,
      confidence: best.confidence,
      explanation:
        second && second.score >= best.score
          ? `"${need}" fits ${best.entry.id} and ${second.entry.id} equally (score ${best.score}); picking one would be a guess.`
          : `"${need}" matches ${best.entry.id} only weakly (confidence ${best.confidence.toFixed(2)} < ${CONFIDENCE_THRESHOLD}); picking it would be a guess.`,
      card: buildChoiceCard(need, ranked, native),
    }
  }
  const chain = fallbackChain(best.entry.id).filter(
    (link) => link.kind !== "mcp" || !options.disabled?.has(link.server),
  )
  return {
    kind: "mcp",
    server: best.entry.id,
    chain,
    confidence: best.confidence,
    reasons: best.reasons,
    explanation: [
      `${best.entry.id} fits "${need}" (score ${best.score}, confidence ${best.confidence.toFixed(2)}, matched: ${best.reasons.join(", ")}).`,
      ...(chain.length > 0
        ? [
            `If it is down, fall back to ${chain
              .map((link) => (link.kind === "mcp" ? link.server : `native ${link.tools.join("/")}`))
              .join(" → ")}.`,
          ]
        : []),
    ].join(" "),
    ranked,
  }
}
