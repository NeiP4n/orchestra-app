export * as SessionContextGovernor from "./context-governor.js"

import { Message, type ContentPart, type ToolResultPart } from "@orchestra/ai"

// On by default. Turn it off with the "Context governor" setting (experimental.context_governor in the config),
// or with ORCHESTRA_CONTEXT_GOVERNOR=0, which also overrides the setting; =1 forces it on.
// ORCHESTRA_CONTEXT_GOVERNOR_SOFT sets the request size, in tokens, at which it acts (default 80000).
//
// A coding session spends most of its prompt on tool output the model read once and never needed again:
// file reads, grep and shell results from fifty steps ago are re-sent on every step. Compaction fixes that
// by summarizing, which is slow, lossy and runs late. The governor is the cheap step before it. When a request
// grows past the soft limit it replaces old, bulky tool outputs with a one-line stub in the request only; the
// durable history keeps every byte, the call arguments stay visible, and the model can run the tool again.
//
// The prompt cache is the other half of the design. Eliding a little on every step would rewrite the prefix
// on every step and cost more than it saves. So elision is a ratchet: a per-session watermark marks how much
// of the history is elided, it moves only when the request crosses the soft limit, and it jumps in one go to
// just before the recent window. Between jumps the prefix is byte-identical, so the provider's cache keeps hitting.
export interface Policy {
  /** Estimated request tokens at which the watermark advances. */
  readonly soft: number
  /** Most recent messages that are never elided. */
  readonly keep: number
  /** Smallest tool output, in characters, worth a stub. */
  readonly min: number
}

export const DEFAULT_SOFT = 80_000

// What the config says; the config plugin keeps it current. Process-wide, like the global config it comes from.
// `undefined` means the setting was never written, and that keeps the governor on: it is the cheap way to
// stop paying for tool output the model already read.
let configured: boolean | undefined
export const configure = (enabled: boolean | undefined) => {
  configured = enabled
}

/** The policy, or undefined when the config or the environment turns the governor off. */
export const policy = (): Policy | undefined => {
  const flag = process.env.ORCHESTRA_CONTEXT_GOVERNOR?.toLowerCase()
  const off = flag === "0" || flag === "false"
  const on = flag === "1" || flag === "true"
  if (off || (!on && configured === false)) return undefined
  const soft = Number(process.env.ORCHESTRA_CONTEXT_GOVERNOR_SOFT)
  return { soft: Number.isFinite(soft) && soft > 0 ? soft : DEFAULT_SOFT, keep: 12, min: 1_500 }
}

// Results that carry decisions, instructions or the team's state; the model must keep seeing them.
// `rules` is here on purpose: a `rules list` answer is the standing rulebook, and eliding it
// would let the model forget a rule it was told to follow for the rest of the session.
const KEPT = new Set(["question", "skill", "dod", "tools", "rules"])
// About 3.5 characters per token across prose, JSON schema and code, as the request report assumes.
const CHARS_PER_TOKEN = 3.5
const MEDIA_CHARS = 1_500
const CAPACITY = 200

interface Mark {
  readonly key: string
  /** Messages before this index have their bulky tool outputs elided. */
  watermark: number
  /** Fingerprint of the last elided message; a mismatch means history was rewritten. */
  anchor: string
}

export const make = () => {
  const marks = new Map<string, Mark>()

  return (input: {
    readonly sessionID: string
    readonly key: string
    readonly messages: ReadonlyArray<Message>
    readonly policy: Policy
  }): ReadonlyArray<Message> => {
    const known = marks.get(input.sessionID)
    const mark =
      known !== undefined && known.key === input.key && intact(known, input.messages)
        ? known
        : { key: input.key, watermark: 0, anchor: "" }

    const limit = input.messages.length - input.policy.keep
    const advanced =
      limit > mark.watermark && tokens(apply(input.messages, mark.watermark, input.policy)) >= input.policy.soft
    if (advanced) mark.watermark = limit
    mark.anchor = fingerprint(input.messages[mark.watermark - 1])

    marks.delete(input.sessionID)
    marks.set(input.sessionID, mark)
    if (marks.size > CAPACITY) marks.delete(marks.keys().next().value as string)
    return mark.watermark === 0 ? input.messages : apply(input.messages, mark.watermark, input.policy)
  }
}

// History only grows between steps; compaction, revert, or fork rewrite it, and then the watermark starts over.
const intact = (mark: Mark, messages: ReadonlyArray<Message>) =>
  mark.watermark <= messages.length && (mark.watermark === 0 || fingerprint(messages[mark.watermark - 1]) === mark.anchor)

const fingerprint = (message: Message | undefined) =>
  message === undefined ? "" : (message.id ?? String(Bun.hash(JSON.stringify(message.content))))

const apply = (messages: ReadonlyArray<Message>, watermark: number, policy: Policy) =>
  watermark === 0
    ? messages
    : messages.map((message, index) => (index < watermark ? elide(message, policy.min) : message))

const elide = (message: Message, min: number) => {
  if (message.role !== "tool" || !message.content.some((part) => elidable(part, min))) return message
  return new Message({
    ...message,
    content: message.content.map((part) => (elidable(part, min) ? stub(part as ToolResultPart) : part)),
  })
}

// A result that carries an image is elided like any other: a screenshot from fifty steps ago is re-sent
// as base64 on every step, and the model can take another one. Media is not a decision to keep, and
// leaving it in made the governor unable to shrink the image-heavy sessions it mostly acts on.
const elidable = (part: ContentPart, min: number) =>
  part.type === "tool-result" &&
  !part.providerExecuted &&
  !KEPT.has(part.name) &&
  part.result.type !== "error" &&
  resultChars(part.result) >= min

const stub = (part: ToolResultPart): ToolResultPart => {
  const media = part.result.type === "content" && part.result.value.some((item) => item.type === "file")
  return {
    ...part,
    result: {
      type: "text",
      value: `[${part.name} output elided: ${media ? "an image or other binary payload" : `${resultChars(part.result)} characters`} from an earlier step. The call above shows what ran. Do not guess or reconstruct the output; run it again if you need it.]`,
    },
  }
}

const resultChars = (result: ToolResultPart["result"]) => {
  if (result.type === "content") return result.value.reduce((total, item) => total + JSON.stringify(item).length, 0)
  return typeof result.value === "string" ? result.value.length : (JSON.stringify(result.value)?.length ?? 0)
}

const sizes = new WeakMap<Message, number>()

const chars = (message: Message) => {
  const known = sizes.get(message)
  if (known !== undefined) return known
  const size = message.content.reduce(
    (total, part) => total + (part.type === "media" ? MEDIA_CHARS : JSON.stringify(part).length),
    0,
  )
  sizes.set(message, size)
  return size
}

const tokens = (messages: ReadonlyArray<Message>) =>
  messages.reduce((total, message) => total + chars(message), 0) / CHARS_PER_TOKEN
