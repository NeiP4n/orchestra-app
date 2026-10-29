import { tr } from "../util/i18n"
// The flow line above the prompt: one row that says whether the model is alive.
//
// It exists to answer a question the transcript cannot: "is it working, or is it stuck?". The
// line is quiet when idle, flashes once on send, breathes while waiting for the first word, flows
// faster the faster text arrives, turns amber and blinks when nothing has arrived for too long,
// and dissolves a moment after the answer is complete. All of the decisions are here, pure and
// testable; the component only paints them.

export type FlowMode = "idle" | "sent" | "waiting" | "streaming" | "stalled" | "done"

export type FlowSample = {
  readonly busy: boolean
  readonly now: number
  // When the current run began, and when the person's message went out.
  readonly startedAt: number | undefined
  readonly sentAt: number | undefined
  // The last time the answer grew (text, reasoning or a tool step), and when the run ended.
  readonly lastGrowthAt: number | undefined
  readonly finishedAt: number | undefined
}

export const SENT_MS = 600
export const STREAMING_MS = 2_000
export const STALL_MS = 10_000
export const FIRST_WORD_STALL_MS = 20_000
export const DONE_MS = 1_500

export function flowMode(sample: FlowSample): FlowMode {
  if (sample.busy) {
    if (sample.sentAt !== undefined && sample.now - sample.sentAt < SENT_MS) return "sent"
    if (sample.lastGrowthAt === undefined) {
      return sample.startedAt !== undefined && sample.now - sample.startedAt >= FIRST_WORD_STALL_MS ? "stalled" : "waiting"
    }
    const quiet = sample.now - sample.lastGrowthAt
    if (quiet >= STALL_MS) return "stalled"
    return quiet <= STREAMING_MS ? "streaming" : "waiting"
  }
  if (sample.finishedAt !== undefined && sample.now - sample.finishedAt < DONE_MS) return "done"
  return "idle"
}

// A view opened while the model is already running never saw the run begin, so counting from "now"
// would show 0 s forever and never reach the stalled look. The newest message is the best evidence of
// when the run last made progress.
export function inheritedStart(busy: boolean, newestMessageAt: number | undefined, now: number) {
  if (!busy) return undefined
  return newestMessageAt !== undefined && newestMessageAt <= now ? newestMessageAt : now
}

const seconds = (ms: number) => Math.max(0, Math.round(ms / 1000))

export function flowLabel(mode: FlowMode, sample: FlowSample, rate: number) {
  switch (mode) {
    case "sent":
      return tr("sent")
    case "waiting":
      return tr("waiting for an answer {seconds} s", { seconds: seconds(sample.now - (sample.lastGrowthAt ?? sample.startedAt ?? sample.now)) })
    case "streaming":
      return rate > 0 ? tr("stream · {rate} chars/s", { rate: Math.round(rate) }) : tr("stream")
    case "stalled":
      return tr("no data for {seconds} s · Esc to interrupt", { seconds: seconds(sample.now - (sample.lastGrowthAt ?? sample.startedAt ?? sample.now)) })
    case "done":
      return tr("done · {seconds} s", { seconds: seconds((sample.finishedAt ?? sample.now) - (sample.startedAt ?? sample.now)) })
    case "idle":
      return ""
  }
}

// How fast the pattern travels, in cells per second: it follows the real rate of the text, so a
// fast answer looks fast and a trickle looks like a trickle.
export function flowSpeed(mode: FlowMode, rate: number) {
  switch (mode) {
    case "sent":
      return 40
    case "waiting":
      return 3
    case "streaming":
      return 6 + Math.min(30, rate / 8)
    default:
      return 0
  }
}

const FLOW = ["░", "▒", "▓", "▒"]

// The pattern itself. `offset` is how far it has travelled; a stalled line stops flowing and
// blinks instead, so the change cannot be missed.
export function flowPattern(mode: FlowMode, width: number, offset: number, blink = false) {
  if (width <= 0 || mode === "idle") return ""
  const cells = Array.from({ length: width }, (_, column) => {
    switch (mode) {
      case "stalled":
        return blink ? "╌" : " "
      case "waiting": {
        // A single soft spot sweeps a quiet line.
        const spot = Math.floor(offset) % (width + 6)
        return Math.abs(column - spot) <= 1 ? (column === spot ? "▒" : "░") : "╌"
      }
      case "done":
        return "─"
      default:
        return FLOW[(((column - Math.floor(offset)) % 4) + 4) % 4]
    }
  })
  return cells.join("")
}

// How many characters per second arrived lately; the window forgets old samples.
export function createRate(windowMs = 3_000) {
  const samples: { at: number; size: number }[] = []
  return {
    push(now: number, size: number) {
      samples.push({ at: now, size })
      while (samples.length > 2 && now - samples[0].at > windowMs) samples.shift()
    },
    perSecond(now: number) {
      const last = samples.at(-1)
      const first = samples.find((sample) => now - sample.at <= windowMs) ?? samples[0]
      if (!last || !first || last.at === first.at) return 0
      return Math.max(0, ((last.size - first.size) / (last.at - first.at)) * 1000)
    },
    reset() {
      samples.length = 0
    },
  }
}
