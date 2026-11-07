export * as SessionContextDensify from "./context-densify.js"

import { Message, type ContentPart, type ToolResultPart } from "@orchestra/ai"
import { Schema } from "effect"

// Headroom pilot (news run 7, БРАТЬ №2), implemented as a native deterministic
// layer instead of the upstream Python library: the library needs a Python
// runtime plus an ONNX/ML stack, phones home with an opt-out telemetry beacon,
// and on this machine its log/search paths either saved 0% or hit their 20 s
// internal timeout and failed open to a passthrough. The one upstream shape
// that provably wins here is the lossless densification of repeated JSON
// arrays (SmartCrusher-style): 87% saved on a 1_000-row commit array, every
// distinct SHA kept. This module ports only that shape, in pure TypeScript,
// with no network, no model and no telemetry of any kind.
//
// The transform is lossless by construction and verified by round-trip: the
// compacted form expands back to JSON that is canonically identical to the
// input, and any input that fails the check is returned unchanged. The output
// is deterministic per input, so a provider prompt-cache prefix stays stable
// across steps — the same property Headroom's own agent mode relies on.
//
// Unlike the context governor, which stubs old bulky output away, the
// densifier keeps every value: it only stops repeating the object keys on
// every row. It therefore also applies to recent results the governor must
// keep, and to the KEPT tools (dod, rules, …) whose results the governor
// never elides.
//
// Off by default: enable with ORCHESTRA_CONTEXT_DENSIFY=1 (pilot flag).
export const enabled = (): boolean => {
  const flag = process.env.ORCHESTRA_CONTEXT_DENSIFY?.toLowerCase()
  return flag === "1" || flag === "true"
}

/** Smallest text, in characters, worth densifying. Below this the saving cannot matter. */
export const MIN_CHARS = 1_000

/** Smallest relative saving worth rewriting a result for. Below this the churn costs more than it saves. */
export const MIN_SAVING = 0.1

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))

export interface DensifiedText {
  readonly text: string
  /** Characters removed; 0 when the input is returned unchanged. */
  readonly savedChars: number
  readonly applied: boolean
}

/** Densify one tool-result text, or return it unchanged when nothing provably lossless applies. */
export const densifyText = (text: string): DensifiedText => {
  if (text.length < MIN_CHARS) return { text, savedChars: 0, applied: false }
  const compacted = compactJsonText(text)
  if (compacted === undefined || text.length - compacted.length < text.length * MIN_SAVING)
    return { text, savedChars: 0, applied: false }
  return { text: compacted, savedChars: text.length - compacted.length, applied: true }
}

export interface DensifiedMessages {
  readonly messages: ReadonlyArray<Message>
  readonly savedChars: number
  /** How many tool-result parts were rewritten. */
  readonly densifiedParts: number
}

/** Densify the tool results of a request. Messages without a densifiable result keep their identity. */
export const densifyMessages = (messages: ReadonlyArray<Message>): DensifiedMessages => {
  let savedChars = 0
  let densifiedParts = 0
  const densified = messages.map((message) => {
    if (message.role !== "tool") return message
    if (!message.content.some((part) => densifiable(part))) return message
    const content = message.content.map((part) => {
      if (!densifiable(part)) return part
      const rewritten = rewriteResult(part)
      if (rewritten === part) return part
      savedChars += densifiedTextSaved(part, rewritten)
      densifiedParts += 1
      return rewritten
    })
    return content.every((part, index) => part === message.content[index])
      ? message
      : new Message({ ...message, content })
  })
  return { messages: densified, savedChars, densifiedParts }
}

const densifiedTextSaved = (before: ToolResultPart, after: ToolResultPart) => {
  if (before.result.type !== "text" || after.result.type !== "text") return 0
  if (typeof before.result.value !== "string" || typeof after.result.value !== "string") return 0
  return before.result.value.length - after.result.value.length
}

const rewriteResult = (part: ToolResultPart): ToolResultPart => {
  if (part.result.type !== "text" || typeof part.result.value !== "string") return part
  const densified = densifyText(part.result.value)
  if (!densified.applied) return part
  return { ...part, result: { ...part.result, value: densified.text } }
}

// Only plain text results: "content" results carry files/media, and "json"
// results carry structured values the protocols lower separately — neither is
// a string this transform may rewrite. Errors are never touched.
const densifiable = (part: ContentPart): part is ToolResultPart =>
  part.type === "tool-result" &&
  !part.providerExecuted &&
  part.result.type === "text" &&
  typeof part.result.value === "string"

// --- JSON array densification -------------------------------------------------

type JsonObject = { readonly [key: string]: unknown }

/** A compacted array, or undefined when the text holds no densifiable JSON array. */
const compactJsonText = (text: string): string | undefined => {
  const trimmed = text.trim()
  const parsed = decodeJson(trimmed)
  if (parsed._tag === "Some") {
    const value = parsed.value
    if (Array.isArray(value)) return compactRows(value)
    if (typeof value === "object" && value !== null) {
      const entries = Object.entries(value)
      if (entries.length === 1 && Array.isArray(entries[0]?.[1]))
        return compactRows(entries[0][1] as ReadonlyArray<unknown>, entries[0][0])
    }
    return undefined
  }
  return compactJsonLines(text)
}

/** Newline-delimited JSON: every non-empty line an object with the same keys. */
const compactJsonLines = (text: string): string | undefined => {
  const lines = text.split("\n").filter((line) => line.trim().length > 0)
  if (lines.length < 3) return undefined
  const rows: Array<JsonObject> = []
  for (const line of lines) {
    const parsed = decodeJson(line.trim())
    if (parsed._tag === "None" || typeof parsed.value !== "object" || parsed.value === null || Array.isArray(parsed.value))
      return undefined
    rows.push(parsed.value as JsonObject)
  }
  return compactRows(rows)
}

// One row per object, keys written once. Values stay JSON, so numbers, booleans
// and null survive exactly; the header names the shape so the model can read
// it without a decoder. The round-trip check below is the guarantee: a
// compacted form that does not expand back to the input is discarded.
const compactRows = (rows: ReadonlyArray<unknown>, wrapper?: string): string | undefined => {
  if (rows.length < 3) return undefined
  if (rows.some((row) => typeof row !== "object" || row === null || Array.isArray(row))) return undefined
  const objects = rows as ReadonlyArray<JsonObject>
  const keys = Object.keys(objects[0] as JsonObject)
  if (keys.length === 0) return undefined
  if (objects.some((row) => !sameKeys(Object.keys(row), keys))) return undefined
  // Run-length dedup: only CONSECUTIVE identical rows collapse. A counts
  // list cannot express non-consecutive repeats (the same commit at rows 0
  // and 200) without reordering the array, so those stay as separate rows —
  // the round-trip check below would reject anything else. Repeated lines
  // in real tool output do come in runs, and the value factoring below
  // still compresses the non-consecutive repeats.
  const unique: Array<ReadonlyArray<unknown>> = []
  const counts: Array<number> = []
  for (const row of objects) {
    const values = keys.map((key) => row[key])
    if (unique.length > 0 && JSON.stringify(values) === JSON.stringify(unique[unique.length - 1])) {
      counts[counts.length - 1] = (counts[counts.length - 1] as number) + 1
    } else {
      unique.push(values)
      counts.push(1)
    }
  }
  // Value factoring, like Headroom's agent mode: a column whose values repeat
  // (status, author, date — or the same SHA in five copies of a commit) lists
  // each distinct string once, and rows carry indices. Only all-string
  // columns qualify, and only when the dictionary is actually cheaper than
  // repeating the values: the saving is estimated from the JSON sizes, so a
  // column of unique SHAs stays inline while a column of five-times-repeated
  // SHAs is factored. Exactly reversible; the round-trip check proves it.
  const dict: { [key: string]: ReadonlyArray<string> } = {}
  const factored = unique.map((values) => [...values])
  keys.forEach((key, index) => {
    const values = unique.map((row) => row[index])
    if (values.some((value) => typeof value !== "string")) return
    const distinct: Array<string> = []
    for (const value of values as Array<string>) if (!distinct.includes(value)) distinct.push(value)
    if (distinct.length >= unique.length) return
    const originalCost = values.reduce<number>((total, value) => total + JSON.stringify(value).length, 0)
    const indexDigits = String(Math.max(0, distinct.length - 1)).length
    const factoredCost =
      distinct.reduce<number>((total, value) => total + JSON.stringify(value).length, 0) + unique.length * indexDigits
    if (factoredCost >= originalCost) return
    dict[key] = distinct
    factored.forEach((row, rowIndex) => {
      row[index] = distinct.indexOf(values[rowIndex] as string)
    })
  })
  const hasCounts = counts.some((count) => count > 1)
  const hasDict = Object.keys(dict).length > 0
  const body: {
    keys: ReadonlyArray<string>
    rows: ReadonlyArray<ReadonlyArray<unknown>>
    wrapper?: string
    dict?: { [key: string]: ReadonlyArray<string> }
    counts?: ReadonlyArray<number>
  } = {
    keys,
    rows: factored,
    ...(wrapper !== undefined ? { wrapper } : {}),
    ...(hasDict ? { dict } : {}),
    ...(hasCounts ? { counts } : {}),
  }
  const compacted =
    `[densified JSON: ${rows.length} rows x ${keys.length} columns${hasCounts ? `, ${unique.length} rows after collapsing repeats` : ""}; each row lists values in key order; ` +
    `${hasDict ? "dictionary columns list their values once and rows carry indices; " : ""}` +
    `${hasCounts ? "counts[i] says how many times row i repeats consecutively; " : ""}` +
    `the original JSON is exactly recoverable]\n${JSON.stringify(body)}`
  const expanded = expandBody(body)
  return canonical(expanded) === canonical(wrappedOriginal(objects, wrapper)) ? compacted : undefined
}

const wrappedOriginal = (rows: ReadonlyArray<JsonObject>, wrapper?: string): unknown =>
  wrapper !== undefined ? { [wrapper]: rows } : rows

const sameKeys = (left: ReadonlyArray<string>, right: ReadonlyArray<string>) =>
  left.length === right.length && left.every((key) => right.includes(key))

const expandBody = (body: {
  keys: ReadonlyArray<string>
  rows: ReadonlyArray<ReadonlyArray<unknown>>
  wrapper?: string
  dict?: { [key: string]: ReadonlyArray<string> }
  counts?: ReadonlyArray<number>
}): unknown => {
  const array = body.rows.flatMap((values, rowIndex) => {
    const object = Object.fromEntries(
      body.keys.map((key, index) => {
        const raw = values[index]
        const valuesList = body.dict?.[key]
        return [key, typeof raw === "number" && valuesList !== undefined ? valuesList[raw] : raw]
      }),
    )
    const count = body.counts?.[rowIndex] ?? 1
    return Array.from({ length: count }, () => object)
  })
  return body.wrapper !== undefined ? { [body.wrapper]: array } : array
}

// Canonical JSON: key order must not matter, but types and values must match
// exactly (true is not 1, 1 is not 1.0 in JSON text — canonical JSON keeps
// them distinct).
const canonical = (value: unknown): string =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(",")}]`
    : typeof value === "object" && value !== null
      ? `{${Object.keys(value)
          .sort()
          .map((key) => `${JSON.stringify(key)}:${canonical((value as JsonObject)[key])}`)
          .join(",")}}`
      : JSON.stringify(value) ?? "null"

/** Expand a densified block back to the original JSON (tests and debugging; not used in the request path). */
export const expandDensified = (text: string): unknown => {
  const lines = text.split("\n")
  if (lines.length < 2 || !lines[0]?.startsWith("[densified JSON:")) return undefined
  const decoded = decodeJson(lines.slice(1).join("\n"))
  if (decoded._tag === "None") return undefined
  const body = decoded.value as { keys?: unknown; rows?: unknown; wrapper?: unknown; dict?: unknown; counts?: unknown }
  if (!Array.isArray(body.keys) || !Array.isArray(body.rows)) return undefined
  return expandBody({
    keys: body.keys as ReadonlyArray<string>,
    rows: body.rows as ReadonlyArray<ReadonlyArray<unknown>>,
    wrapper: typeof body.wrapper === "string" ? body.wrapper : undefined,
    dict: typeof body.dict === "object" && body.dict !== null ? (body.dict as { [key: string]: ReadonlyArray<string> }) : undefined,
    counts: Array.isArray(body.counts) ? (body.counts as ReadonlyArray<number>) : undefined,
  })
}
