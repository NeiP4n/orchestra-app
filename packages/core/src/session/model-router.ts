export * as ModelRouter from "./model-router.js"

// Smart Token Router: picks how much model a piece of work deserves. The classifier is a pure
// function of the request, so the same task always lands on the same tier and the decision can be
// logged, replayed and tested; the router then picks the cheapest candidate that can run the tier's
// reasoning variant. Nothing here performs I/O or reads configuration: the caller passes the
// catalog it already loaded and gets a decision back.
export type Tier = "trivial" | "standard" | "deep"

export interface ClassifyInput {
  readonly task: string
  readonly role?: string
  readonly mode?: string
  /**
   * The files the task is expected to touch. `item` and `tokens` are accepted for the caller's
   * context, but the specification defines no weight for them yet, so they never move the score.
   */
  readonly files?: ReadonlyArray<{ readonly path: string; readonly lines?: number }>
  readonly item?: { readonly steps: number; readonly dependent: boolean }
  readonly attempts?: number
  readonly tokens?: number
}

export interface Classification {
  readonly tier: Tier
  readonly score: number
  readonly strong: boolean
  readonly reasons: ReadonlyArray<string>
}

export interface CatalogCost {
  readonly input: number
  readonly output: number
  readonly tier?: { readonly type: string; readonly size: number }
}

export interface CatalogModel {
  readonly id: string
  readonly providerID?: string
  readonly variants?: ReadonlyArray<{ readonly id: string }>
  readonly cost?: ReadonlyArray<CatalogCost>
}

export interface RouteInput {
  readonly tier: Tier
  readonly candidates: ReadonlyArray<string>
  readonly catalog?: ReadonlyArray<CatalogModel>
  readonly pinned?: string
  readonly tokens?: number
}

export interface RouteResult {
  readonly model: string
  readonly variant?: string
  readonly reason: string
  readonly skipped: ReadonlyArray<{ readonly model: string; readonly why: string }>
}

// Keyword stems rather than whole words, because Russian inflects: "архитектур" covers
// "архитектура", "архитектуры" and "архитектурный".
const strongKeywords = [
  { pattern: /архитектур/, label: "архитектура" },
  { pattern: /контракт/, label: "контракты" },
  { pattern: /гонк/, label: "гонки" },
  { pattern: /\bdeadlock/i, label: "deadlock" },
  { pattern: /уязвим/, label: "уязвимости" },
  { pattern: /реверс/, label: "реверс" },
  { pattern: /аудит/, label: "аудит" },
  { pattern: /architectur/i, label: "architecture" },
  { pattern: /contract/i, label: "contracts" },
  { pattern: /\brace\b/i, label: "race" },
  { pattern: /vulnerab/i, label: "vulnerabilities" },
  { pattern: /reverse/i, label: "reverse" },
  { pattern: /audit/i, label: "audit" },
]

const cheapKeywords = [
  { pattern: /опечатк/, label: "опечатка" },
  { pattern: /\btypo/i, label: "typo" },
  { pattern: /\blint\b/i, label: "lint" },
  { pattern: /форматирован/, label: "форматирование" },
  { pattern: /\bformat/i, label: "format" },
  { pattern: /найди файл/, label: "найди файл" },
  { pattern: /\bfind (?:the )?file/i, label: "find file" },
  { pattern: /покажи/, label: "покажи" },
  { pattern: /show me/i, label: "show me" },
  { pattern: /статус/, label: "статус" },
  { pattern: /\bstatus\b/i, label: "status" },
]

const workKeywords = [
  { pattern: /тест/, label: "тест" },
  { pattern: /\btest/i, label: "test" },
  { pattern: /компонент/, label: "компонент" },
  { pattern: /component/i, label: "component" },
  { pattern: /фикс/, label: "фикс" },
  { pattern: /\bfix\b/i, label: "fix" },
]

const strongRole = /(plan|architect|design|audit|strateg|analys)/
const reviewRole = /(review|quality)/
const debugRole = /debug/
const buildRole = /(build|coding|test|develop|implement)/

const deepMode = /(architecture|planning|design)/
const standardMode = /(review|debug)/
const cheapMode = /(fast|auto)/

const variants: Record<Tier, ReadonlyArray<string>> = {
  trivial: ["minimal", "fast"],
  standard: ["low", "medium", "fast"],
  deep: ["high", "max"],
}

/** The reasoning variants a tier asks for, in preference order. */
export function tierVariants(tier: Tier): ReadonlyArray<string> {
  return variants[tier]
}

export function classify(input: ClassifyInput): Classification {
  const task = input.task.toLowerCase()
  const role = (input.role ?? "").toLowerCase()
  const mode = (input.mode ?? "").toLowerCase()
  const attempts = Math.max(0, input.attempts ?? 0)
  const files = input.files ?? []
  const lines = files.reduce((total, file) => total + Math.max(0, file.lines ?? 0), 0)
  const reasons: string[] = []
  let score = 0

  // Role first: what the agent is asked to do says more than any single word in the request.
  const roleWeight = strongRole.test(role) ? 4 : reviewRole.test(role) ? 3 : debugRole.test(role) ? 2 : buildRole.test(role) ? 1 : 0
  if (roleWeight > 0) {
    score += roleWeight
    reasons.push(`role ${role} (+${roleWeight})`)
  }

  const modeDeep = deepMode.test(mode)
  const modeStandard = standardMode.test(mode)
  const modeCheap = cheapMode.test(mode)
  const modeWeight = modeDeep ? 4 : modeStandard ? 2 : modeCheap ? -2 : /coding/.test(mode) ? 1 : 0
  if (modeWeight !== 0) {
    score += modeWeight
    reasons.push(`${mode} mode (${modeWeight > 0 ? "+" : ""}${modeWeight}${modeDeep ? ", floor deep" : modeStandard ? ", floor standard" : modeCheap ? ", ceiling trivial" : ""})`)
  }

  const strong = strongKeywords.filter((keyword) => keyword.pattern.test(task))
  if (strong.length > 0) {
    const weight = Math.min(strong.length * 3, 6)
    score += weight
    reasons.push(`hard work ${strong.map((keyword) => keyword.label).join(", ")} (+${weight})`)
  }

  const cheap = cheapKeywords.filter((keyword) => keyword.pattern.test(task))
  if (cheap.length > 0) {
    const weight = Math.min(cheap.length * 4, 8)
    score -= weight
    reasons.push(`mechanical work ${cheap.map((keyword) => keyword.label).join(", ")} (-${weight})`)
  }

  const work = workKeywords.filter((keyword) => keyword.pattern.test(task))
  if (work.length > 0) {
    const weight = Math.min(work.length, 2)
    score += weight
    reasons.push(`ordinary work ${work.map((keyword) => keyword.label).join(", ")} (+${weight})`)
  }

  const length = input.task.trim().length
  const lengthWeight = length < 120 ? -1 : length > 3000 ? 2 : length >= 800 ? 1 : 0
  if (lengthWeight !== 0) {
    score += lengthWeight
    reasons.push(`task length ${length} (${lengthWeight > 0 ? "+" : ""}${lengthWeight})`)
  }

  const fileWeight = files.length === 0 ? 0 : files.length > 8 ? 2 : files.length >= 3 ? 1 : lines < 300 ? -1 : 0
  if (fileWeight !== 0) {
    score += fileWeight
    reasons.push(`files ${files.length}, ${lines} lines (${fileWeight > 0 ? "+" : ""}${fileWeight})`)
  }

  if (attempts >= 2) {
    score += 3
    reasons.push(`retry ${attempts} (+3)`)
  }

  // A retry is evidence the first answer was not enough, so it escalates the tier on its own; every
  // other strong signal is a role or a mode that asks for design work.
  const strongSignal = strongRole.test(role) || modeDeep || strong.length > 0 || attempts >= 2
  const base: Tier = score <= -2 ? "trivial" : score >= 4 && strongSignal ? "deep" : "standard"
  const tier: Tier = modeCheap ? "trivial" : modeDeep ? "deep" : modeStandard && base === "trivial" ? "standard" : base

  if (tier !== base) reasons.push(`mode floor/ceiling moved ${base} to ${tier}`)
  return { tier, score, strong: strongSignal, reasons }
}

export function route(input: RouteInput): RouteResult {
  if (input.pinned?.trim()) {
    const pinned = split(input.pinned.trim())
    return { model: pinned.base, ...(pinned.variant ? { variant: pinned.variant } : {}), reason: "pinned by the caller", skipped: [] }
  }

  const wanted = variants[input.tier]
  const skipped: { model: string; why: string }[] = []
  const priced: { model: string; variant?: string; price: number }[] = []

  for (const candidate of input.candidates) {
    const ref = split(candidate)
    if (input.catalog === undefined) continue
    const entry = input.catalog.find((model) => reference(model) === ref.base || (!ref.base.includes("/") && model.id === ref.base))
    if (!entry) {
      skipped.push({ model: candidate, why: "not in the catalog" })
      continue
    }
    const price = priceOf(entry.cost, input.tokens ?? 0)
    if (price === undefined) {
      skipped.push({ model: candidate, why: "no price" })
      continue
    }
    const variant = ref.variant ?? wanted.find((id) => entry.variants?.some((item) => item.id === id))
    priced.push({ model: ref.base, ...(variant ? { variant } : {}), price })
  }

  if (priced.length > 0) {
    // A model that offers one of the tier's reasoning variants beats a cheaper one that cannot
    // reason at that level; only when nothing offers it does the router fall back to any price.
    const preferred = priced.filter((candidate) => candidate.variant !== undefined)
    const pool = preferred.length > 0 ? preferred : priced
    const best = pool.toSorted((left, right) => left.price - right.price)[0]
    priced
      .filter((candidate) => candidate !== best)
      .forEach((candidate) =>
        skipped.push({
          model: candidate.model,
          why: pool.includes(candidate)
            ? `priced higher (${round(candidate.price)} > ${round(best.price)})`
            : `no ${input.tier} reasoning variant`,
        }),
      )
    return {
      model: best.model,
      ...(best.variant ? { variant: best.variant } : {}),
      reason: `cheapest of ${pool.length} priced candidate(s): ${round(best.price)} USD per million tokens`,
      skipped,
    }
  }

  // Without a catalog there is nothing to compare, and with one nothing could be priced: take the
  // first candidate with a variant the tier asks for, or the first candidate at all, and say so.
  const fallback = input.candidates.find((candidate) => wanted.includes(split(candidate).variant ?? "")) ?? input.candidates[0]
  if (fallback === undefined) throw new Error("ModelRouter.route: no candidates")
  const ref = split(fallback)
  input.candidates
    .filter((candidate) => candidate !== fallback)
    .forEach((candidate) =>
      skipped.push({ model: candidate, why: input.catalog === undefined ? "no catalog: cannot compare prices" : "not priced" }),
    )
  return {
    model: ref.base,
    ...(ref.variant ? { variant: ref.variant } : {}),
    reason: input.catalog === undefined ? "no catalog: took the first candidate" : "no candidate could be priced: took a candidate anyway",
    skipped,
  }
}

// `provider/model#variant`, the same shape Model.Ref.parse accepts, but tolerant: the router must
// answer for whatever the caller configured, including a bare model id.
function split(reference: string) {
  const providerEnd = reference.indexOf("/")
  const variantStart = reference.indexOf("#", providerEnd + 1)
  return {
    base: variantStart === -1 ? reference : reference.slice(0, variantStart),
    variant: variantStart === -1 ? undefined : reference.slice(variantStart + 1),
  }
}

function reference(model: CatalogModel) {
  return model.providerID ? `${model.providerID}/${model.id}` : model.id
}

// The same context-tier rule the usage accounting uses: the longest tier the request already
// passes wins, otherwise the base price applies.
function priceOf(cost: ReadonlyArray<CatalogCost> | undefined, tokens: number) {
  if (!cost || cost.length === 0) return undefined
  const tier = cost
    .filter((item) => item.tier?.type === "context" && tokens > item.tier.size)
    .toSorted((left, right) => (right.tier?.size ?? 0) - (left.tier?.size ?? 0))[0]
  const item = tier ?? cost.find((entry) => entry.tier === undefined)
  if (!item) return undefined
  return item.input + item.output
}

const round = (value: number) => Math.round(value * 100) / 100
