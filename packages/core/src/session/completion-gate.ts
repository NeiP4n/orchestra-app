export * as SessionCompletionGate from "./completion-gate.js"

import type { Dod } from "../dod.js"
import type { SessionMessage } from "./message.js"

// The model deciding it is finished is not evidence that it is. When a run would go idle, the
// harness looks at what the session itself committed to and wakes it once more with the exact
// gap: board items it took that still have unchecked steps, or a reply that ends with a promise
// instead of the work. Everything it reads is durable (history and the DoD board), so a session
// resumed after a restart or a provider limit is held to the same commitments.
export const MetadataKey = "orchestra:completion-gate"

// ORCHESTRA_COMPLETION_NUDGES=0 turns the gate off; the default allows three wake-ups per user turn.
const limit = () => {
  const value = Number(process.env.ORCHESTRA_COMPLETION_NUDGES ?? process.env.OPENCODE_COMPLETION_NUDGES ?? 3)
  return Number.isFinite(value) && value >= 0 ? value : 3
}

// The AI's own items carry this owner on the board; see DodTool.owner. `dod next` stamps the id,
// older items written by hand carry only the name.
const AI_OWNER = "AI"
const AI_OWNER_ID = "local-ai"
const WORK_ACTIONS = new Set(["next", "take", "add", "check", "uncheck"])

// A reply whose last paragraph announces work instead of reporting it.
const PROMISE =
  /^(?:(?:ok(?:ay)?|now|next|then|first)[,:]?\s+)?(?:i(?:'ll| will| am going to|'m going to)|let me|next,? i|now i|сейчас|теперь|далее|дальше|затем|следующ\S* шаг|(?:я\s+)?(?:сделаю|запущу|проверю|исправлю|добавлю|начну|займусь|продолжу))(?=[\s,.!:;…]|$)/iu

export function check(messages: ReadonlyArray<SessionMessage.Info>, board: Dod.Status) {
  const max = limit()
  if (max === 0) return undefined
  const start = messages.findLastIndex((message) => message.type === "user")
  const turn = messages.slice(start + 1)
  const nudges = turn.filter((message) => message.type === "synthetic" && message.metadata?.[MetadataKey] === true)
  if (nudges.length >= max) return undefined
  const last = turn.findLast((message) => message.type === "assistant")
  if (!last || last.type !== "assistant" || last.error || last.finish !== "stop") return undefined
  // A model that answers a nudge without doing anything has said it is done twice; believe it.
  const previous = turn.findLastIndex((message) => message.type === "synthetic" && message.metadata?.[MetadataKey] === true)
  if (previous >= 0 && !turn.slice(previous + 1).some((message) => message.type === "assistant" && tools(message).length > 0))
    return undefined
  const text = last.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n").trim()
  // Asking the operator is a legitimate place to stop.
  if (tools(last).some((tool) => tool.name === "question") || /[?？]\s*$/.test(text)) return undefined

  // If the session has dispatched work to a team worker and is waiting for <team-report>,
  // do not nudge. The worker's completion report will wake the session reactively.
  if (hasOutstandingTasks(messages)) return undefined

  const open = openItems(messages, board)
  if (open.length > 0)
    return reminder([
      "Completion check: the board still holds work this session took.",
      ...open,
      "Continue with the next unchecked step now and check each step as it is really done. Stop only when every step is checked and the item is verified (`dod verify`), when a blocker needs someone else (`dod block` with the reason), or when a decision only the user can make is open (ask it).",
    ])
  const paragraph = text.split(/\n\s*\n/).at(-1)?.trim() ?? ""
  if (PROMISE.test(paragraph))
    return reminder([
      "Completion check: your reply ended by announcing work instead of doing it.",
      "Do that work now with your tools, then report the result. If it cannot be done, say exactly what blocks it.",
    ])
  return undefined
}

function openItems(messages: ReadonlyArray<SessionMessage.Info>, board: Dod.Status) {
  if (board.type !== "ready") return []
  const calls = messages.flatMap((message) =>
    message.type === "assistant" ? tools(message).filter((tool) => tool.name === "dod") : [],
  )
  const inputs = calls.map((tool) =>
    "input" in tool.state && typeof tool.state.input === "object" ? tool.state.input : {},
  )
  if (!inputs.some((input) => WORK_ACTIONS.has(String(input.action)))) return []
  const named = new Set(inputs.flatMap((input) => (typeof input.id === "string" ? [input.id] : [])))
  return board.items
    .filter((item) => item.state === "IN_PROGRESS" && item.done < item.total)
    .filter(
      (item) =>
        named.has(item.id) ||
        (item.owner === AI_OWNER && (item.ownerID === undefined || item.ownerID === AI_OWNER_ID)),
    )
    .slice(0, 3)
    .map((item) => {
      const left = (board.steps?.get(item.id) ?? []).filter((step) => !/^\s*\[x\]/i.test(step)).slice(0, 5)
      return [`- ${item.id} "${item.what}": ${item.done}/${item.total} steps checked.`, ...left.map((step) => `  ${step}`)].join("\n")
    })
}

function tools(message: SessionMessage.Assistant) {
  return message.content.filter((part) => part.type === "tool")
}

function reminder(lines: ReadonlyArray<string>) {
  return `<system-reminder>\n${lines.join("\n")}\n</system-reminder>`
}

function hasOutstandingTasks(messages: ReadonlyArray<SessionMessage.Info>): boolean {
  let dispatched = 0
  let reported = 0
  for (const message of messages) {
    if (message.type === "assistant") {
      for (const part of message.content) {
        if (part.type === "tool" && part.name === "sessions") {
          const input = typeof part.state.input === "object" && part.state.input !== null ? part.state.input : {}
          if ((input as any).action === "send" || ((input as any).action === "create" && (input as any).text)) {
            if (part.state.status === "completed") {
              dispatched++
            }
          }
        }
      }
    } else if (message.type === "synthetic") {
      if (
        message.text.includes("<team-report") ||
        (message.metadata as any)?.source === "team"
      ) {
        reported++
      }
    }
  }
  return dispatched > reported
}
