export * as SessionPrefixPin from "./prefix-pin.js"

import { Message, type SystemPart } from "@orchestra/ai"

// Pins are process-local cache hints; the least recently used sessions fall out first.
const CAPACITY = 200
// Once the updates outweigh this share of the pinned prompt, one full cache miss is cheaper than carrying them.
const NOTE_BUDGET_RATIO = 0.25
const NOTE_BUDGET_MIN = 8_000

interface Note {
  readonly at: number
  readonly anchor: string
  readonly message: Message
  readonly size: number
}

interface Pin {
  readonly key: string
  readonly head: string
  readonly system: ReadonlyArray<SystemPart>
  readonly notes: Array<Note>
  seen: string
}

/**
 * Keeps the system prompt byte-stable for the provider's prompt cache.
 *
 * Plugins and context hooks often rebuild part of the system prompt every user turn (lessons, status lines,
 * plan reminders). Any change there invalidates the cached prefix for the whole conversation, and an uncached
 * step waits for the provider to prefill the entire history again. Instead, the first system prompt a session
 * sends stays pinned, and a later change enters history as a system update at the position where it was first
 * seen. That update keeps its position on later steps, so everything before it remains a cache hit.
 */
export const make = () => {
  const pins = new Map<string, Pin>()

  return (input: {
    readonly sessionID: string
    readonly key: string
    readonly system: ReadonlyArray<SystemPart>
    readonly messages: ReadonlyArray<Message>
  }) => {
    const seen = signature(input.system)
    const pin = pins.get(input.sessionID)
    if (pin === undefined || pin.key !== input.key || !anchored(pin, input.messages)) return repin(pins, input, seen)

    if (seen !== pin.seen) {
      const message = update(pin.system, input.system)
      const size = textOf(message).length
      const used = pin.notes.reduce((total, note) => total + note.size, size)
      if (used > Math.max(NOTE_BUDGET_MIN, signature(pin.system).length * NOTE_BUDGET_RATIO))
        return repin(pins, input, seen)
      pin.notes.push({ at: input.messages.length, anchor: fingerprint(input.messages.at(-1)), message, size })
      pin.seen = seen
    }

    pins.delete(input.sessionID)
    pins.set(input.sessionID, pin)
    return {
      system: pin.system,
      messages: pin.notes.reduceRight(
        (messages, note) => [...messages.slice(0, note.at), note.message, ...messages.slice(note.at)],
        input.messages,
      ),
    }
  }
}

const repin = (
  pins: Map<string, Pin>,
  input: {
    readonly sessionID: string
    readonly key: string
    readonly system: ReadonlyArray<SystemPart>
    readonly messages: ReadonlyArray<Message>
  },
  seen: string,
) => {
  pins.delete(input.sessionID)
  pins.set(input.sessionID, {
    key: input.key,
    head: fingerprint(input.messages[0]),
    system: input.system,
    notes: [],
    seen,
  })
  if (pins.size > CAPACITY) pins.delete(pins.keys().next().value as string)
  return { system: input.system, messages: input.messages }
}

// History only grows between steps; compaction, revert, or fork rewrite it, and then the pin starts over.
const anchored = (pin: Pin, messages: ReadonlyArray<Message>) =>
  fingerprint(messages[0]) === pin.head &&
  pin.notes.every((note) => note.at <= messages.length && fingerprint(messages[note.at - 1]) === note.anchor)

const fingerprint = (message: Message | undefined) =>
  message === undefined ? "" : (message.id ?? String(Bun.hash(JSON.stringify(message.content))))

const signature = (system: ReadonlyArray<SystemPart>) => system.map((part) => part.text).join("\u0000")

const textOf = (message: Message) => message.content.map((part) => (part.type === "text" ? part.text : "")).join("")

const update = (pinned: ReadonlyArray<SystemPart>, current: ReadonlyArray<SystemPart>) => {
  const before = new Set(pinned.map((part) => part.text))
  const after = new Set(current.map((part) => part.text))
  // A rules block is never dumped whole and never reduced to its first line: the model
  // must see exactly which rules appeared and which disappeared, or a removed rule keeps
  // being followed from the pinned prompt and an added one is easy to miss.
  const diff = rulesDiff(
    pinned.filter((part) => !after.has(part.text)),
    current.filter((part) => !before.has(part.text)),
  )
  const added = current.filter((part) => !before.has(part.text) && !isRulesBlock(part.text))
  const removed = pinned.filter((part) => !after.has(part.text) && !isRulesBlock(part.text)).map((part) => summary(part.text))
  if (added.length === 0 && removed.length === 0 && diff.length === 0)
    return Message.system("The system prompt above is current again; earlier system updates no longer apply.")
  return Message.system(
    [
      "Parts of the system prompt changed after this conversation started. The text below is their current version and replaces the earlier version of those parts, including any earlier system update.",
      ...diff,
      ...added.map((part) => `\n${part.text}`),
      ...(removed.length === 0
        ? []
        : ["\nThese earlier parts of the system prompt no longer apply:", ...removed.map((text) => `- ${text}`)]),
    ].join("\n"),
  )
}

// The rules change as a diff: added rule lines with `+`, removed ones with `-`. An empty
// result means the rules did not change, even when another part of the prompt did.
const rulesDiff = (removed: ReadonlyArray<SystemPart>, added: ReadonlyArray<SystemPart>) => {
  const oldRules = removed.filter((part) => isRulesBlock(part.text)).flatMap((part) => ruleLines(part.text))
  const newRules = added.filter((part) => isRulesBlock(part.text)).flatMap((part) => ruleLines(part.text))
  if (oldRules.length === 0 && newRules.length === 0) return []
  const gone = oldRules.filter((line) => !newRules.includes(line))
  const fresh = newRules.filter((line) => !oldRules.includes(line))
  if (gone.length === 0 && fresh.length === 0) return []
  return [
    "Rules changed since this conversation started. Added rules now apply, removed rules no longer apply, and every other rule stays as it was:",
    ...fresh.map((line) => `+ ${line}`),
    ...gone.map((line) => `- ${line}`),
  ]
}

const isRulesBlock = (text: string) => text.startsWith("# Rules\n") || text === "# Rules"

const ruleLines = (text: string) => text.split("\n").filter((line) => line.startsWith("- ["))

const summary = (text: string) => {
  const line = text.trim().split("\n")[0] ?? ""
  return line.length > 120 ? `${line.slice(0, 120)}…` : line
}
