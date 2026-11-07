export * as MemoryLevels from "./levels.js"

import { randomUUID } from "node:crypto"
import { appendFile, mkdir, readFile, readdir } from "node:fs/promises"
import path from "node:path"
import { ProjectFilesPaths } from "../project-files/paths.js"
import { MemoryRank } from "./rank.js"
import { writeAtomic } from "../write-atomic.js"

/**
 * Three-level memory, slices L2 (project) + L1 (society) of block Б17.
 *
 * Layout (approved design, ~/workspace/orchestra-claude-mem-draft.md §1):
 *
 * - L2, project root `<project>/.orchestra/memory/` — `MEMORY.md` (≤ 12 KiB,
 *   a render of `index.json`, never hand-edited), `daily/` (candidates
 *   proposed by sessions), `actors/` (per-actor notes), `index.json` (the
 *   store of promoted facts). Promotion is daily → MEMORY.md, at most 5
 *   facts per session, only what would hurt to restore.
 * - L1, society root `<society>/.orchestra/memory/` — `MEMORY.md`,
 *   `charter.md`, `rules.md`, `decisions/`, `lessons/`, `agents/`,
 *   `blocks/`, `daily/`, `archive/`, `members.md`, `acl.yaml`. A human
 *   writes everything; the council writes decisions/lessons/rules; the
 *   orchestrator and agents only propose (a proposal is a line in the
 *   society daily, never a direct edit).
 *
 * Rules of the design, enforced here, not by convention:
 *
 * - Promotion goes only up and only curated: nothing reaches L2 without
 *   an explicit `promoteSessionFacts` call, nothing reaches L1 without
 *   `promoteProjectToSociety` by a human or the council.
 * - The two levels live under different roots. A call that takes a
 *   project root can never write into a society root and vice versa.
 * - Secrets never land in files. There is NO scrubber in this module on
 *   purpose: the foundation slice owns `memory/scrub.ts`, and every write
 *   here takes an optional `scrub` function (HOOK-POINT below) that the
 *   caller plugs in. Until the foundation slice lands, callers pass
 *   nothing and text is stored as-is — a known gap, see the slice report.
 * - No vector database, no Chroma, no Python: search is the existing
 *   offline BM25 rank (`rank.ts`) over the file store, with progressive
 *   disclosure — compact index, then timeline, then details by ID.
 *
 * Paths never contain a hand-built `.orchestra/...` string: both roots
 * resolve through `ProjectFilesPaths.writePath`, the Б16 file-layer
 * pattern (legacy `.opencode/` fallback stays in one place).
 */

// HOOK-POINT: plug the foundation slice's scrubber here (memory/scrub.ts,
// `scrubText`). Every write in this module runs user text through the
// `scrub` option when one is supplied; without it text is stored as-is.
// Do NOT grow a second scrubber in this file.
export type ScrubFn = (text: string) => string

export interface WriteOptions {
  /** Secret scrubber from the foundation slice; identity when omitted. */
  scrub?: ScrubFn
  /** Override for "today" (`YYYY-MM-DD`); the real date when omitted. */
  date?: string
}

export class MemoryLevelsError extends Error {
  readonly code: "denied" | "budget" | "invalid" | "not-found" | "corrupt"
  constructor(code: MemoryLevelsError["code"], message: string) {
    super(message)
    this.code = code
  }
}

/** L2 `MEMORY.md` budget from the approved design: 12 KiB, fail-closed. */
export const PROJECT_MEMORY_LIMIT_BYTES = 12 * 1024
/** At most this many facts per session cross from daily into MEMORY.md. */
export const MAX_PROMOTED_PER_SESSION = 5
/** A search query longer than this is truncated, never rejected. */
export const MAX_QUERY_CHARS = 500
/** One fact line is at most this long; longer text is truncated with a marker. */
export const MAX_FACT_CHARS = 2000

export const FACT_TYPES = ["decision", "bugfix", "feature", "refactor", "discovery", "change"] as const
export type FactType = (typeof FACT_TYPES)[number]

/** Observation types that hurt to restore even without an explicit flag. */
const PAINFUL_TYPES: ReadonlyArray<FactType> = ["decision", "bugfix", "discovery"]

export type WriterRole = "human" | "council" | "orchestrator" | "agent"

export interface Fact {
  readonly id: string
  readonly text: string
  readonly type: FactType
  readonly tags: ReadonlyArray<string>
  readonly painful: boolean
  readonly sourceSession: string
  readonly created: string
  readonly promotedAt: string
}

export interface DailyCandidate {
  readonly id: string
  readonly type: FactType
  readonly painful: boolean
  readonly sessionId: string
  readonly tags: ReadonlyArray<string>
  readonly text: string
  readonly status: "candidate" | "promoted" | "rejected"
  readonly date: string
  readonly file: string
  readonly line: number
}

export interface Skipped {
  readonly id: string
  readonly reason: "not-painful" | "over-limit" | "budget" | "not-found" | "duplicate"
}

export interface PromotionResult {
  readonly promoted: ReadonlyArray<Fact>
  readonly skipped: ReadonlyArray<Skipped>
}

export interface SearchHit {
  readonly id: string
  readonly kind: "fact" | "daily" | "actor"
  readonly title: string
  readonly score: number
  /** Rough token estimate of the hit, so callers can budget the prompt. */
  readonly approxTokens: number
}

export interface TimelineEntry {
  readonly id: string
  readonly kind: "fact" | "daily" | "actor"
  readonly date: string
  readonly snippet: string
}

export interface FactDetail {
  readonly id: string
  readonly kind: "fact" | "daily"
  readonly text: string
  readonly type: FactType
  readonly tags: ReadonlyArray<string>
  readonly sourceSession: string
  readonly created: string
  readonly promotedAt?: string
}

/** Project memory root: `<projectDir>/.orchestra/memory/`. */
export const projectMemoryRoot = (projectDir: string): string => ProjectFilesPaths.writePath(projectDir, "memory")

/** Society memory root: `<societyDir>/.orchestra/memory/` — a different root, never the project one. */
export const societyMemoryRoot = (societyDir: string): string => ProjectFilesPaths.writePath(societyDir, "memory")

const memoryFile = (root: string): string => path.join(root, "MEMORY.md")
const indexFile = (root: string): string => path.join(root, "index.json")
const dailyFile = (root: string, date: string): string => path.join(root, "daily", `${date}.md`)
const actorFile = (root: string, actor: string): string => path.join(root, "actors", `${actor}.md`)

const today = (override?: string): string => override ?? new Date().toISOString().slice(0, 10)

const oneLine = (text: string): string => text.replaceAll(/\s+/g, " ").trim()

const cleanText = (text: string, scrub?: ScrubFn): string => {
  const cleaned = oneLine(scrub ? scrub(text) : text)
  if (cleaned.length <= MAX_FACT_CHARS) return cleaned
  return `${cleaned.slice(0, MAX_FACT_CHARS)}…[truncated: ${cleaned.length - MAX_FACT_CHARS} chars]`
}

const newId = (): string => `f_${randomUUID().replaceAll("-", "").slice(0, 8)}`

const isFactType = (value: string): value is FactType => (FACT_TYPES as ReadonlyArray<string>).includes(value)

const fail = (code: MemoryLevelsError["code"], message: string): never => {
  throw new MemoryLevelsError(code, message)
}

const readTextSafe = async (file: string): Promise<string | undefined> => {
  try {
    return await readFile(file, "utf8")
  } catch (error) {
    if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined
    throw error
  }
}

const isValidDate = (date: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(Date.parse(date))

// ---------------------------------------------------------------------------
// L2: daily candidates + promotion
// ---------------------------------------------------------------------------

/**
 * A session proposes a fact for the project memory. This writes ONLY to
 * `daily/` — nothing reaches `MEMORY.md` until `promoteSessionFacts`
 * runs, so the levels never leak into each other on their own.
 */
export const appendDailyCandidate = async (
  root: string,
  input: {
    text: string
    type: FactType
    sessionId: string
    painful?: boolean
    tags?: ReadonlyArray<string>
  },
  options?: WriteOptions,
): Promise<DailyCandidate> => {
  const text = cleanText(input.text, options?.scrub)
  if (text === "") fail("invalid", "Nothing to remember: text is empty.")
  if (!isFactType(input.type)) fail("invalid", `Unknown fact type: ${input.type}.`)
  if (input.sessionId.trim() === "") fail("invalid", "sessionId must not be empty.")
  const date = today(options?.date)
  if (!isValidDate(date)) fail("invalid", `Bad date: ${date}.`)
  const tags = [...new Set((input.tags ?? []).map((tag) => oneLine(tag).toLowerCase()).filter(Boolean))]
  const candidate: DailyCandidate = {
    id: newId(),
    type: input.type,
    painful: input.painful ?? false,
    sessionId: input.sessionId,
    tags,
    text,
    status: "candidate",
    date,
    file: dailyFile(root, date),
    line: 0,
  }
  await mkdir(path.dirname(candidate.file), { recursive: true })
  await appendFile(candidate.file, `${formatDailyLine(candidate)}\n`, "utf8")
  return candidate
}

const formatDailyLine = (candidate: DailyCandidate): string => {
  const mark = candidate.status === "promoted" ? "x" : candidate.status === "rejected" ? "-" : " "
  const painful = candidate.painful ? "painful" : "routine"
  const tags = candidate.tags.join(",")
  return `- [${mark}] ${candidate.id} | ${candidate.type} | ${painful} | session:${candidate.sessionId} | tags:${tags} | ${candidate.text}`
}

const parseDailyLine = (line: string, file: string, lineNo: number, date: string): DailyCandidate | undefined => {
  const match = line.match(
    /^- \[( |x|-)\] (\S+) \| (\S+) \| (painful|routine) \| session:(\S+) \| tags:([^|]*) \| (.*)$/,
  )
  if (!match) return undefined
  const type = match[3]
  if (!isFactType(type)) return undefined
  return {
    id: match[2],
    type,
    painful: match[4] === "painful",
    sessionId: match[5],
    tags: match[6]
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean),
    text: match[7],
    status: match[1] === "x" ? "promoted" : match[1] === "-" ? "rejected" : "candidate",
    date,
    file,
    line: lineNo,
  }
}

/** Every candidate in `daily/`, oldest first. Lines that do not parse are free-form notes, ignored. */
export const readDailyCandidates = async (root: string): Promise<ReadonlyArray<DailyCandidate>> => {
  const dir = path.join(root, "daily")
  let names: Array<string>
  try {
    names = (await readdir(dir)).filter((name) => name.endsWith(".md")).toSorted()
  } catch {
    return []
  }
  const found: Array<DailyCandidate> = []
  for (const name of names) {
    const date = name.slice(0, -3)
    if (!isValidDate(date)) continue
    const content = await readTextSafe(path.join(dir, name))
    if (content === undefined) continue
    content.split("\n").forEach((line, lineNo) => {
      const candidate = parseDailyLine(line, path.join(dir, name), lineNo, date)
      if (candidate) found.push(candidate)
    })
  }
  return found
}

/** The `code--chill` bar: only what would hurt to restore is worth promoting. */
export const qualifiesForPromotion = (candidate: Pick<DailyCandidate, "type" | "painful">): boolean =>
  candidate.painful || PAINFUL_TYPES.includes(candidate.type)

/** The promoted facts of a project, from `index.json` (missing file = no facts yet). */
export const readProjectIndex = async (root: string): Promise<ReadonlyArray<Fact>> => {
  const content = await readTextSafe(indexFile(root))
  if (content === undefined) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    fail("corrupt", `Project memory index is not valid JSON: ${indexFile(root)}.`)
  }
  if (typeof parsed !== "object" || parsed === null || !Array.isArray((parsed as { facts?: unknown }).facts))
    fail("corrupt", `Project memory index has an unknown shape: ${indexFile(root)}.`)
  const facts = (parsed as { facts: Array<Record<string, unknown>> }).facts
  for (const fact of facts) {
    if (typeof fact.id !== "string" || typeof fact.text !== "string" || !isFactType(String(fact.type ?? "")))
      fail("corrupt", `Project memory index holds a malformed fact: ${indexFile(root)}.`)
  }
  return facts as unknown as ReadonlyArray<Fact>
}

export const renderProjectMemory = (facts: ReadonlyArray<Fact>): string => {
  const lines = [
    "# Память проекта",
    "",
    "<!-- Сгенерировано из index.json — правки вносятся продвижением из daily, ручные правки затрутся при следующем продвижении. -->",
    "",
  ]
  for (const fact of facts) {
    lines.push(
      `- [${fact.type}] ${fact.text} (id ${fact.id}, сессия ${fact.sourceSession}, ${fact.promotedAt.slice(0, 10)})`,
    )
  }
  lines.push("")
  return lines.join("\n")
}

const writeProjectIndex = async (root: string, facts: ReadonlyArray<Fact>): Promise<void> => {
  const rendered = renderProjectMemory(facts)
  if (Buffer.byteLength(rendered, "utf8") > PROJECT_MEMORY_LIMIT_BYTES)
    fail(
      "budget",
      `MEMORY.md would hold ${Buffer.byteLength(rendered, "utf8")} of ${PROJECT_MEMORY_LIMIT_BYTES} bytes. Condense or drop facts; the file is never silently truncated.`,
    )
  await mkdir(root, { recursive: true })
  await writeAtomic(indexFile(root), `${JSON.stringify({ version: 1, facts }, null, 2)}\n`)
  await writeAtomic(memoryFile(root), rendered)
}

/**
 * Curated promotion daily → MEMORY.md for one session. At most 5 facts,
 * only those that pass the painful-to-restore bar. Everything else is
 * reported as skipped and stays a candidate — never promoted silently,
 * never dropped silently.
 */
export const promoteSessionFacts = async (
  root: string,
  sessionId: string,
  options?: WriteOptions & { maxFacts?: number },
): Promise<PromotionResult> => {
  const maxFacts = Math.min(MAX_PROMOTED_PER_SESSION, Math.max(1, options?.maxFacts ?? MAX_PROMOTED_PER_SESSION))
  const candidates = (await readDailyCandidates(root)).filter(
    (candidate) => candidate.sessionId === sessionId && candidate.status === "candidate",
  )
  // The cap is per session in total, not per call: facts this session
  // already promoted count against it, so a second call cannot smuggle
  // a 6th fact through.
  const alreadyPromoted = (await readProjectIndex(root)).filter((fact) => fact.sourceSession === sessionId).length
  const allowance = Math.max(0, maxFacts - alreadyPromoted)
  const skipped: Array<Skipped> = []
  const eligible = candidates.filter((candidate) => {
    if (!qualifiesForPromotion(candidate)) {
      skipped.push({ id: candidate.id, reason: "not-painful" })
      return false
    }
    return true
  })
  const chosen = eligible.slice(0, allowance)
  for (const extra of eligible.slice(allowance)) skipped.push({ id: extra.id, reason: "over-limit" })
  const now = new Date().toISOString()
  const existing = await readProjectIndex(root)
  const promoted: Array<Fact> = []
  let facts = existing
  for (const candidate of chosen) {
    if (facts.some((fact) => fact.id === candidate.id)) {
      skipped.push({ id: candidate.id, reason: "duplicate" })
      continue
    }
    const fact: Fact = {
      id: candidate.id,
      text: candidate.text,
      type: candidate.type,
      tags: candidate.tags,
      painful: candidate.painful,
      sourceSession: candidate.sessionId,
      created: `${candidate.date}T00:00:00.000Z`,
      promotedAt: now,
    }
    const trial = renderProjectMemory([...facts, fact])
    if (Buffer.byteLength(trial, "utf8") > PROJECT_MEMORY_LIMIT_BYTES) {
      skipped.push({ id: candidate.id, reason: "budget" })
      continue
    }
    facts = [...facts, fact]
    promoted.push(fact)
  }
  if (promoted.length > 0) await writeProjectIndex(root, facts)
  const promotedIds = new Set(promoted.map((fact) => fact.id))
  const touched = new Set(
    candidates.filter((candidate) => promotedIds.has(candidate.id)).map((candidate) => candidate.file),
  )
  for (const file of touched) {
    const content = await readTextSafe(file)
    if (content === undefined) continue
    const lines = content.split("\n")
    const next = lines
      .map((line, lineNo) => {
        const candidate = parseDailyLine(line, file, lineNo, path.basename(file, ".md"))
        if (candidate && promotedIds.has(candidate.id)) return formatDailyLine({ ...candidate, status: "promoted" })
        return line
      })
      .join("\n")
    await writeAtomic(file, next)
  }
  return { promoted, skipped }
}

/** A dated line in `actors/<actor>.md`. Actor names are lowercase slugs. */
export const recordActor = async (
  root: string,
  actor: string,
  text: string,
  options?: WriteOptions,
): Promise<string> => {
  if (!/^[a-z][a-z0-9-]{1,39}$/.test(actor)) fail("invalid", `Actor name must be a lowercase slug, got: ${actor}.`)
  const cleaned = cleanText(text, options?.scrub)
  if (cleaned === "") fail("invalid", "Nothing to record: text is empty.")
  const file = actorFile(root, actor)
  await mkdir(path.dirname(file), { recursive: true })
  await appendFile(file, `- ${today(options?.date)} ${cleaned}\n`, "utf8")
  return file
}

// ---------------------------------------------------------------------------
// L2: search with progressive disclosure (search → timeline → get)
// ---------------------------------------------------------------------------

interface SearchDoc {
  readonly id: string
  readonly kind: "fact" | "daily" | "actor"
  readonly text: string
  readonly tags: ReadonlyArray<string>
  readonly updated: number
  readonly date: string
}

/** All searchable documents of a project: promoted facts, daily candidates, actor lines. */
const collectSearchDocs = async (root: string): Promise<Array<SearchDoc>> => {
  const docs: Array<SearchDoc> = []
  for (const fact of await readProjectIndex(root)) {
    docs.push({
      id: fact.id,
      kind: "fact",
      text: fact.text,
      tags: fact.tags,
      updated: Date.parse(fact.promotedAt) || 0,
      date: fact.promotedAt.slice(0, 10),
    })
  }
  for (const candidate of await readDailyCandidates(root)) {
    docs.push({
      id: candidate.id,
      kind: "daily",
      text: candidate.text,
      tags: candidate.tags,
      updated: Date.parse(`${candidate.date}T00:00:00.000Z`) + candidate.line,
      date: candidate.date,
    })
  }
  const actorsDir = path.join(root, "actors")
  let actorFiles: Array<string> = []
  try {
    actorFiles = (await readdir(actorsDir)).filter((name) => name.endsWith(".md")).toSorted()
  } catch {
    actorFiles = []
  }
  for (const name of actorFiles) {
    const content = await readTextSafe(path.join(actorsDir, name))
    if (content === undefined) continue
    const actor = name.slice(0, -3)
    content.split("\n").forEach((line, lineNo) => {
      const match = line.match(/^- (\d{4}-\d{2}-\d{2}) (.*)$/)
      if (!match) return
      docs.push({
        id: `actor:${actor}:${lineNo}`,
        kind: "actor",
        text: match[2],
        tags: [actor],
        updated: Date.parse(`${match[1]}T00:00:00.000Z`) + lineNo,
        date: match[1],
      })
    })
  }
  return docs
}

/**
 * Layer 1 — compact index. A hit carries a short title and a token
 * estimate (~50–100 tokens), never the full text: the caller filters
 * here and only then asks for details by ID.
 *
 * The query is plain text for the offline BM25 rank; it is never
 * interpolated into SQL, FTS5 or a regex, so injection strings are just
 * words that match nothing (see the injection tests).
 */
export const searchProjectMemory = async (
  root: string,
  query: string,
  options?: { limit?: number },
): Promise<ReadonlyArray<SearchHit>> => {
  const trimmed = query.slice(0, MAX_QUERY_CHARS).trim()
  if (trimmed === "") return []
  const limit = Math.min(20, Math.max(1, options?.limit ?? 8))
  const docs = await collectSearchDocs(root)
  return MemoryRank.rank(trimmed, docs)
    .slice(0, limit)
    .map((item) => {
      const title = oneLine(item.document.text).slice(0, 160)
      return {
        id: item.document.id,
        kind: item.document.kind,
        title,
        score: Math.round(item.score * 1000) / 1000,
        approxTokens: Math.max(1, Math.ceil(title.length / 4)),
      }
    })
}

/**
 * Layer 2 — chronological context. Around given IDs it returns the
 * neighbours (±2 in time order); without IDs, the most recent entries.
 */
export const timelineProjectMemory = async (
  root: string,
  options?: { ids?: ReadonlyArray<string>; limit?: number },
): Promise<ReadonlyArray<TimelineEntry>> => {
  const limit = Math.min(50, Math.max(1, options?.limit ?? 10))
  const docs = (await collectSearchDocs(root)).toSorted((a, b) => a.updated - b.updated)
  let picked: Array<SearchDoc>
  if (options?.ids && options.ids.length > 0) {
    const wanted = new Set(options.ids)
    const indexes = docs.map((doc, index) => ({ doc, index })).filter((entry) => wanted.has(entry.doc.id))
    const around = new Set<number>()
    for (const entry of indexes) {
      for (let offset = -2; offset <= 2; offset++) {
        const at = entry.index + offset
        if (at >= 0 && at < docs.length) around.add(at)
      }
    }
    picked = [...around].toSorted((a, b) => a - b).map((index) => docs[index])
  } else {
    picked = docs.slice(-limit)
  }
  return picked.map((doc) => ({
    id: doc.id,
    kind: doc.kind,
    date: doc.date,
    snippet: oneLine(doc.text).slice(0, 200),
  }))
}

/** Layer 3 — full details, only for the IDs the caller already filtered. */
export const getProjectMemoryFacts = async (
  root: string,
  ids: ReadonlyArray<string>,
): Promise<ReadonlyArray<FactDetail>> => {
  const wanted = new Set(ids)
  const facts = (await readProjectIndex(root)).filter((fact) => wanted.has(fact.id))
  const candidates = (await readDailyCandidates(root)).filter((candidate) => wanted.has(candidate.id))
  const byId = new Map<string, FactDetail>()
  for (const fact of facts) {
    byId.set(fact.id, {
      id: fact.id,
      kind: "fact",
      text: fact.text,
      type: fact.type,
      tags: fact.tags,
      sourceSession: fact.sourceSession,
      created: fact.created,
      promotedAt: fact.promotedAt,
    })
  }
  for (const candidate of candidates) {
    if (!byId.has(candidate.id)) {
      byId.set(candidate.id, {
        id: candidate.id,
        kind: "daily",
        text: candidate.text,
        type: candidate.type,
        tags: candidate.tags,
        sourceSession: candidate.sessionId,
        created: `${candidate.date}T00:00:00.000Z`,
      })
    }
  }
  return ids.flatMap((id) => (byId.get(id) ? [byId.get(id) as FactDetail] : []))
}

// ---------------------------------------------------------------------------
// L1: society files + minimal ACL + promotion L2 → L1
// ---------------------------------------------------------------------------

export const SOCIETY_FILES = [
  "MEMORY.md",
  "charter.md",
  "rules.md",
  "members.md",
  "acl.yaml",
  "decisions/",
  "lessons/",
  "agents/",
  "blocks/",
  "daily/",
  "archive/",
] as const

/**
 * Minimal ACL (the full `acl.yaml` model is out of this slice): who may
 * write where in the society memory. Human writes everything; the council
 * writes decisions/lessons/rules; the orchestrator and agents write
 * nothing directly — they only propose into the society daily.
 */
export const SOCIETY_ACL: Readonly<Record<WriterRole, ReadonlyArray<string>>> = {
  human: [...SOCIETY_FILES],
  council: ["decisions/", "lessons/", "rules.md"],
  orchestrator: [],
  agent: [],
}

export const canWriteSociety = (role: WriterRole, rel: string): boolean => {
  const allowed = SOCIETY_ACL[role]
  return allowed.some((entry) => (entry.endsWith("/") ? rel.startsWith(entry) : rel === entry))
}

const SOCIETY_REL =
  /^(MEMORY\.md|charter\.md|rules\.md|members\.md|acl\.yaml|decisions\/[a-z0-9][a-z0-9_-]{1,39}\.md|lessons\/[a-z0-9][a-z0-9_-]{1,39}\.md|agents\/[a-z][a-z0-9-]{1,39}\.md|blocks\/[a-z0-9][a-z0-9_-]{1,39}\.md|daily\/\d{4}-\d{2}-\d{2}\.md|archive\/[a-z0-9][a-z0-9_-]{1,39}\.md)$/

const assertSocietyRel = (rel: string): void => {
  if (!SOCIETY_REL.test(rel)) fail("invalid", `Not a society memory file: ${rel}.`)
}

/**
 * Direct write into the society memory, ACL-gated. A denied role gets a
 * loud `denied` error, never a silent skip — and is told to propose
 * instead (see `proposeToSociety`).
 */
export const writeSocietyFile = async (
  root: string,
  role: WriterRole,
  rel: string,
  content: string,
  options?: WriteOptions,
): Promise<string> => {
  assertSocietyRel(rel)
  if (!canWriteSociety(role, rel))
    fail("denied", `Role ${role} may not write ${rel} in the society memory. Propose it in the society daily instead.`)
  const file = path.join(root, rel)
  await writeAtomic(file, options?.scrub ? options.scrub(content) : content)
  return file
}

export interface SocietyProposal {
  readonly id: string
  readonly author: string
  readonly role: WriterRole
  readonly kind: string
  readonly text: string
}

/**
 * The only way the orchestrator and agents touch L1: a proposal line in
 * the society daily. It never edits decisions, lessons or rules itself.
 */
export const proposeToSociety = async (
  root: string,
  proposal: { author: string; role: WriterRole; kind: string; text: string },
  options?: WriteOptions,
): Promise<SocietyProposal> => {
  const text = cleanText(proposal.text, options?.scrub)
  if (text === "") fail("invalid", "Nothing to propose: text is empty.")
  if (proposal.author.trim() === "") fail("invalid", "Proposal author must not be empty.")
  if (proposal.kind.trim() === "") fail("invalid", "Proposal kind must not be empty.")
  const id = newId()
  const file = dailyFile(root, today(options?.date))
  await mkdir(path.dirname(file), { recursive: true })
  await appendFile(
    file,
    `- [proposal] ${id} | ${proposal.kind} | by ${proposal.author} (${proposal.role}) | ${text}\n`,
    "utf8",
  )
  return { id, author: proposal.author, role: proposal.role, kind: proposal.kind, text }
}

/** Human-readable mirror of the in-code ACL table. Enforcement reads the table, not this file. */
export const renderSocietyAcl = (): string => {
  const lines = [
    "# ACL памяти общества (Б17)",
    "# Источник истины — таблица SOCIETY_ACL в packages/core/src/memory/levels.ts;",
    "# этот файл — её читаемое зеркало. Оркестратор и агенты не пишут напрямую никуда.",
    "",
  ]
  for (const role of ["human", "council", "orchestrator", "agent"] as const) {
    const areas = SOCIETY_ACL[role]
    lines.push(`${role}: ${areas.length === 0 ? "(только предложения в daily)" : areas.join(", ")}`)
  }
  lines.push("")
  return lines.join("\n")
}

export const writeSocietyAcl = async (root: string): Promise<string> => {
  const file = path.join(root, "acl.yaml")
  await mkdir(root, { recursive: true })
  await writeAtomic(file, renderSocietyAcl())
  return file
}

/** Create the society memory skeleton. Idempotent: existing files are left alone. */
export const initSocietyMemory = async (root: string): Promise<ReadonlyArray<string>> => {
  const created: Array<string> = []
  for (const dir of ["decisions", "lessons", "agents", "blocks", "daily", "archive"]) {
    await mkdir(path.join(root, dir), { recursive: true })
  }
  const skeletons: ReadonlyArray<readonly [string, string]> = [
    ["MEMORY.md", "# Память общества\n\nДолговременные выводы общества: что решено, чему научились, что действует.\n"],
    ["charter.md", "# Устав общества\n\nЗачем общество существует, его цель и границы.\n"],
    [
      "rules.md",
      "# Правила общества\n\n## hard\n\n<!-- Жёсткие правила: главнее всех остальных правил, включая правила проектов. -->\n\n## soft\n\n<!-- Мягкие правила: из них побеждает самое конкретное (самое узкое applies). -->\n",
    ],
    ["members.md", "# Участники общества\n\n"],
  ]
  for (const [rel, content] of skeletons) {
    const file = path.join(root, rel)
    if ((await readTextSafe(file)) === undefined) {
      await writeAtomic(file, content)
      created.push(rel)
    }
  }
  if ((await readTextSafe(path.join(root, "acl.yaml"))) === undefined) {
    await writeSocietyAcl(root)
    created.push("acl.yaml")
  }
  return created
}

export interface SocietyRule {
  readonly text: string
  readonly hard: boolean
  /** Scope the rule applies to: `*`, `project:<name>`, `project:<name>:<area>`. */
  readonly applies: string
  /** Specificity: the count of non-wildcard segments in `applies`. */
  readonly specificity: number
}

const ruleSpecificity = (applies: string): number =>
  applies === "*" ? 0 : applies.split(":").filter((segment) => segment !== "*").length

/** Parse `rules.md` (`## hard` / `## soft` sections, `- [applies] text` bullets). */
export const parseSocietyRules = (
  rulesMd: string,
): { hard: ReadonlyArray<SocietyRule>; soft: ReadonlyArray<SocietyRule> } => {
  const hard: Array<SocietyRule> = []
  const soft: Array<SocietyRule> = []
  let section: "hard" | "soft" | undefined
  for (const line of rulesMd.split("\n")) {
    if (/^##\s+hard\s*$/.test(line)) section = "hard"
    else if (/^##\s+soft\s*$/.test(line)) section = "soft"
    else if (/^##\s/.test(line)) section = undefined
    else if (section) {
      const match = line.match(/^-\s+\[([^\]]+)\]\s+(.*)$/)
      if (!match || match[2].trim() === "") continue
      const rule: SocietyRule = {
        text: match[2].trim(),
        hard: section === "hard",
        applies: match[1].trim(),
        specificity: ruleSpecificity(match[1].trim()),
      }
      if (section === "hard") hard.push(rule)
      else soft.push(rule)
    }
  }
  return { hard, soft }
}

/**
 * Rule precedence (approved design): hard society rules first, then hard
 * project rules, then soft rules most-specific-first (a society soft rule
 * wins a tie against a project one — same specificity, society first).
 */
export const resolveRules = (
  society: { hard: ReadonlyArray<SocietyRule>; soft: ReadonlyArray<SocietyRule> },
  project: { hard: ReadonlyArray<SocietyRule>; soft: ReadonlyArray<SocietyRule> },
): ReadonlyArray<SocietyRule> => {
  const soft = [
    ...society.soft.map((rule) => ({ rule, society: true })),
    ...project.soft.map((rule) => ({ rule, society: false })),
  ].toSorted((a, b) => b.rule.specificity - a.rule.specificity || (a.society === b.society ? 0 : a.society ? -1 : 1))
  return [...society.hard, ...project.hard, ...soft.map((entry) => entry.rule)]
}

export type SocietyPromotionKind = "decision" | "lesson" | "rule"

/**
 * Curated promotion L2 → L1. Only decisions, lessons and rules cross
 * over, and only a human or the council may move them — the orchestrator
 * and agents get a `denied` error. The project facts stay where they are;
 * the society copy records its source (`from project …, fact …`).
 */
export const promoteProjectToSociety = async (
  projectRoot: string,
  societyRoot: string,
  input: { by: WriterRole; kind: SocietyPromotionKind; factIds: ReadonlyArray<string>; projectName?: string },
  options?: WriteOptions,
): Promise<PromotionResult> => {
  if (input.by !== "human" && input.by !== "council")
    fail(
      "denied",
      `Only a human or the council may promote project memory into the society. Role ${input.by} must propose instead.`,
    )
  const projectName = input.projectName ?? "project"
  const facts = await readProjectIndex(projectRoot)
  const byId = new Map(facts.map((fact) => [fact.id, fact]))
  const promoted: Array<Fact> = []
  const skipped: Array<Skipped> = []
  for (const id of input.factIds) {
    const fact = byId.get(id)
    if (!fact) {
      skipped.push({ id, reason: "not-found" })
      continue
    }
    if (input.kind === "rule") {
      const rulesFile = path.join(societyRoot, "rules.md")
      const existing = (await readTextSafe(rulesFile)) ?? ""
      if (existing.includes(`(факт ${fact.id})`)) {
        skipped.push({ id, reason: "duplicate" })
        continue
      }
      const line = `- [project:${projectName}] ${fact.text} (факт ${fact.id})\n`
      const next = existing.includes("## soft")
        ? existing.replace(/## soft\n/, `## soft\n${line}`)
        : `${existing}\n## soft\n${line}`
      await writeSocietyFile(societyRoot, input.by, "rules.md", next, options)
      promoted.push(fact)
      continue
    }
    const dir = input.kind === "decision" ? "decisions" : "lessons"
    const rel = `${dir}/${fact.id}.md`
    const target = path.join(societyRoot, rel)
    if ((await readTextSafe(target)) !== undefined) {
      skipped.push({ id, reason: "duplicate" })
      continue
    }
    const content = [
      `# ${input.kind === "decision" ? "Решение" : "Урок"} ${fact.id}`,
      "",
      fact.text,
      "",
      `Источник: проект ${projectName}, факт ${fact.id}, сессия ${fact.sourceSession}.`,
      "",
    ].join("\n")
    await writeSocietyFile(societyRoot, input.by, rel, content, options)
    promoted.push(fact)
  }
  return { promoted, skipped }
}
