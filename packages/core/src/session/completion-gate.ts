export * as SessionCompletionGate from "./completion-gate.js"

import { DateTime } from "effect"
import type { Dod } from "../dod.js"
import { ReviewAcceptance } from "../review/acceptance.js"
import { ReviewChecklist } from "../review/checklist.js"
import { ReviewDual } from "../review/dual.js"
import { ReviewRedTeam } from "../review/redteam.js"
import type { SessionMessage } from "./message.js"
import { RoomRules } from "@orchestra/schema/room-rules"

// The model deciding it is finished is not evidence that it is. When a run would go idle, the
// harness looks at what the session itself committed to and wakes it once more with the exact
// gap: board items it took that still have unchecked steps, or a reply that ends with a promise
// instead of the work. Everything it reads is durable (history and the DoD board), so a session
// resumed after a restart or a provider limit is held to the same commitments.
export const MetadataKey = "orchestra:completion-gate"

// Independent-review gates (ideas #1, #7, #9, #17; `packages/core/src/review/`).
// All four are optional and off unless the caller passes them: the gate only
// enforces a review the session actually opened. The review records are
// written at runtime by the reviewing agents; this gate only reads them and
// refuses to let the session stop while one blocks.
// - redTeam: a plan/architecture the red team still blocks (open critical or
//   major findings) is not accepted — address the findings or dismiss them
//   with a reason first (`planGate` is the same check for plan acceptance
//   before coding starts).
// - dual: the merged dual review blocks the same way; a hole both sides
//   found is named first.
// - checklist: a task whose foreign checklist review did not pass is not
//   done — a failed step names what is wrong, an unmarked step is not a pass.
// - acceptance: delivery is blocked until the user-eyes acceptance run
//   passed, or was explicitly deferred with a reason.
export interface ReviewGates {
  readonly redTeam?: ReviewRedTeam.Review
  readonly dual?: ReviewDual.MergedReview
  readonly checklist?: ReviewChecklist.ChecklistReview
  readonly acceptance?: ReviewAcceptance.AcceptanceRun
}

/**
 * Plan acceptance (idea #1, #9): a plan or architecture is accepted for
 * coding only when its red-team review — or its merged dual review — has no
 * open blocking finding. Returns the reason it is not accepted, or undefined
 * when it is. The completion gate calls this too; the orchestrator calls it
 * directly before coding starts.
 */
export function planGate(input: {
  readonly redTeam?: ReviewRedTeam.Review
  readonly dual?: ReviewDual.MergedReview
}): string | undefined {
  const lines: Array<string> = []
  if (input.redTeam) {
    const blocking = ReviewRedTeam.blockingFindings(input.redTeam)
    if (blocking.length > 0)
      lines.push(
        `Red-team review ${input.redTeam.id} blocks this plan: ${blocking.map((finding) => `${finding.severity} "${finding.summary}"`).join("; ")}. Address each finding or dismiss it with a reason — a hole is never waved away silently.`,
      )
  }
  if (input.dual) {
    const blocking = ReviewDual.blockingFindings(input.dual)
    if (blocking.length > 0)
      lines.push(
        `Dual review blocks this architecture: ${blocking.map((entry) => `${entry.severity}${entry.confirmedByBoth ? " (found by both sides — fix first)" : ""} "${entry.summary}"`).join("; ")}. Address each finding or dismiss it with a reason.`,
      )
  }
  return lines.length > 0 ? lines.join("\n") : undefined
}

// Lines the gate adds when a passed-in review record blocks completion, or
// undefined when every passed-in review allows it.
function reviewReminder(reviews: ReviewGates | undefined): Array<string> | undefined {
  if (!reviews) return undefined
  const lines: Array<string> = []
  const plan = planGate(reviews)
  if (plan) lines.push(`Plan acceptance: ${plan}`)
  if (reviews.checklist) {
    const verdict = ReviewChecklist.verdict(reviews.checklist)
    if (verdict === "fail")
      lines.push(
        `Checklist review ${reviews.checklist.id} failed ${reviews.checklist.itemId}: ${ReviewChecklist.failedSteps(reviews.checklist).map((step) => `#${step.index} "${step.text}" — ${step.reason}`).join("; ")}. Fix what failed and ask the foreign reviewer to mark the steps again.`,
      )
    else if (verdict === "pending")
      lines.push(
        `Checklist review ${reviews.checklist.id} of ${reviews.checklist.itemId} is not finished: ${ReviewChecklist.pendingSteps(reviews.checklist).map((step) => `#${step.index} "${step.text}"`).join(", ")} still unmarked. A task is not done until its foreign reviewer marks every DoD step.`,
      )
  }
  if (reviews.acceptance && !ReviewAcceptance.mayShip(reviews.acceptance))
    lines.push(`Acceptance: ${ReviewAcceptance.blockingReason(reviews.acceptance)} Do not report the work delivered until the user-eyes run passes, or defer it with a named reason.`)
  return lines.length > 0 ? ["Independent review blocks completion:", ...lines] : undefined
}

// ORCHESTRA_COMPLETION_NUDGES=0 turns the gate off; the default allows three wake-ups per user turn.
const limit = () => {
  const value = Number(process.env.ORCHESTRA_COMPLETION_NUDGES ?? 3)
  return Number.isFinite(value) && value >= 0 ? value : 3
}

// The AI's own items carry this owner on boards written before owners were per-session;
// see DodTool.ownerOf. `dod next` stamps the session id, older items written by hand carry
// only the name. The gate matches a session's own items by session id first; the shared id
// below is only the legacy fallback for boards claimed before that change.
const AI_OWNER = "AI"
const AI_OWNER_ID = "local-ai"
const WORK_ACTIONS = new Set(["next", "take", "add", "check", "uncheck"])

// A <team-report> whose outcome leaves the task open.
const OPEN_REPORT = /<team-report[^>]*outcome="(?:partial|incomplete|failed|stopped|blocked)"/i

// Phrases of giving up, and the tools whose use shows the agent looked or asked first.
const GIVE_UP =
  /не знаю|не могу|не смог|не получилось|не удалось|нет возможности|\b(?:i )?(?:do not|don't) know\b|\bcan(?:'|no)t\b|\bcannot\b|\bcouldn't\b|\bunable to\b/i
const LOOKUP_TOOLS = new Set([
  "websearch", "webfetch", "research", "memory", "grep", "codegraph", "symbols", "question", "sessions", "subagent", "peer", "federation", "skill", "note",
])

// The state line a BrowserAgent report starts with.
const STATE_LINE = /^\s*(?:DONE|PARTLY DONE|NOT DONE)\b/i

// A reply whose last paragraph announces work instead of reporting it.
const PROMISE =
  /^(?:(?:ok(?:ay)?|now|next|then|first)[,:]?\s+)?(?:i(?:'ll| will| am going to|'m going to)|let me|next,? i|now i|сейчас|теперь|далее|дальше|затем|следующ\S* шаг|(?:я\s+)?(?:сделаю|запущу|проверю|исправлю|добавлю|начну|займусь|продолжу))(?=[\s,.!:;…]|$)/iu

// A dispatched team task with no report for this long is not "outstanding" any more: the
// worker is gone or stuck, and the session must be woken to check on it instead of idling
// forever on a report that will never come.
const STALE_DISPATCH_MS = 30 * 60 * 1000

export function check(
  messages: ReadonlyArray<SessionMessage.Info>,
  board: Dod.Status,
  now?: DateTime.DateTime,
  sessionID?: string,
  reviews?: ReviewGates,
  agent?: string,
) {
  const max = limit()
  if (max === 0) return undefined
  const start = messages.findLastIndex((message) => message.type === "user")
  const turn = messages.slice(start + 1)
  const nudges = turn.filter((message) => message.type === "synthetic" && message.metadata?.[MetadataKey] === true)
  const last = turn.findLast((message) => message.type === "assistant")
  if (!last || last.type !== "assistant" || last.error || last.finish !== "stop") return undefined
  // The BrowserAgent must end a turn with a state line and must have worked in the page. A weak model that
  // stops after a search, or with an empty answer, is sent back to work; when the reminders are spent it is asked
  // for an explicit NOT DONE with the reason, so the Orchestrator never gets silence.
  if (agent === "team-browser-agent") {
    const said = last.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n").trim()
    const usedBrowser = turn.some((message) => message.type === "assistant" && tools(message).some((tool) => tool.name === "browser"))
    if (STATE_LINE.test(said) && (usedBrowser || /^\s*NOT DONE/i.test(said))) return undefined
    if (nudges.length > max) return undefined
    if (nudges.length === max)
      return reminder([
        "Completion check (final): you are stopping without a report.",
        "Write the report now. Its first line is NOT DONE (or PARTLY DONE if part of the task worked), then one or two plain sentences saying what you did in the page and exactly what stopped you. Do not call any tool.",
      ])
    return reminder([
      "Completion check: the page work is not finished and you have not reported.",
      usedBrowser
        ? "Continue in the browser with the next step (snapshot, then click or type by ref). Try another route if the last one failed."
        : "You have not used the browser tool yet. Do the task in the page with the browser tool (open, snapshot, click, type); fetch and search are not a substitute for the page.",
      "End with the first line DONE, PARTLY DONE or NOT DONE and a short plain summary.",
    ])
  }
  // A worker that came back partial, failed or blocked has not finished the task: the Orchestrator sends it on (the
  // same worker with a hint, or another role) before it tells the operator. Limited by the reminder count.
  {
    const lastReport = turn.findLastIndex((message) => message.type === "synthetic" && message.text.includes("<team-report"))
    const report = lastReport >= 0 ? turn[lastReport] : undefined
    if (report?.type === "synthetic" && OPEN_REPORT.test(report.text) && nudges.length < max) {
      const after = turnCalls(turn.slice(lastReport + 1))
      const acted = after.some(
        (call) =>
          (call.name === "sessions" && ["send", "create", "answer"].includes(String(call.input.action))) ||
          call.name === "interact" ||
          call.name === "question",
      )
      if (!acted)
        return reminder([
          "Completion check: a worker's report says the task is partial, failed or blocked, and you have not acted on it.",
          "Do not hand this to the operator yet. Send the task on: to the same worker with a specific hint, or to another role that knows it better (researcher, architect, debugger). Search for the missing information yourself if that is quicker. Write to the operator only after these tries, and list them.",
        ])
    }
  }
  // A model that answers a nudge without doing anything has said it is done twice; believe it.
  const previous = turn.findLastIndex((message) => message.type === "synthetic" && message.metadata?.[MetadataKey] === true)
  if (previous >= 0 && !turn.slice(previous + 1).some((message) => message.type === "assistant" && tools(message).length > 0))
    return undefined
  // "I do not know / I cannot" with no look-up and no question to a colleague is not an answer: it goes back to work.
  {
    const said = last.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n").trim()
    if (said.length > 0 && said.length <= 600 && GIVE_UP.test(said) && nudges.length < max) {
      const tried = turnCalls(turn).some((call) => LOOKUP_TOOLS.has(call.name))
      if (!tried)
        return reminder([
          "Completion check: you are giving up without trying to find out.",
          agent?.startsWith("team-")
            ? "Look it up first (research or websearch, the repository, project notes, memory). If that is not enough, ask a question that names the colleague role that would know (researcher, architect, debugger). Report that you could not only after that, with the list of what you tried."
            : "Search yourself, or send the task to the colleague role that knows it (sessions: researcher, architect, debugger), or return it to the worker with a hint. Tell the operator that it failed only after those tries, with the list.",
        ])
    }
  }
  const text = last.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n").trim()
  // Asking the operator is a legitimate place to stop.
  if (tools(last).some((tool) => tool.name === "question") || /[?？]\s*$/.test(text)) return undefined

  // If the session has dispatched work to a team worker and is waiting for <team-report>,
  // do not nudge. The worker's completion report will wake the session reactively — unless
  // the dispatch went stale (see STALE_DISPATCH_MS): then the report is not coming.
  if (hasOutstandingTasks(messages, now)) return undefined

  const open = openItems(messages, board, sessionID)
  if (nudges.length >= max) {
    // The limit is spent, but the board still holds work this session took: one final
    // escalation instead of silence. It does not ask for more work — it asks the session
    // to block the item with the reason or ask the operator, then stop. The count keeps
    // growing past the limit, so this fires once per turn.
    if (open.length === 0 || nudges.length > max) return undefined
    return reminder([
      "Completion check (final): the board still holds work this session took, after all reminders.",
      ...open,
      "Do not keep working on it silently: block the item with the reason (`dod block`) or ask the operator the question that unblocks it, then stop. If the work is still running elsewhere, say so and stop.",
    ])
  }
  if (open.length > 0)
    return reminder([
      "Completion check: the board still holds work this session took.",
      ...open,
      "Continue with the next unchecked step now and check each step as it is really done. Stop only when every step is checked and the item is verified (`dod verify`), when a blocker needs someone else (`dod block` with the reason), or when a decision only the user can make is open (ask it).",
    ])
  // Every step checked is not DONE: only `dod verify` makes an item DONE, with its evidence.
  // A session that stops here would report the work finished while the board still says otherwise.
  const unverified = unverifiedItems(messages, board, sessionID)
  const touched = forbiddenTouches(turn)
  if (unverified.length > 0 || touched.length > 0)
    return reminder([
      "Completion check: the answer is not verified yet.",
      ...unverified,
      ...touched,
      "Run `dod verify` for each finished item now; a hand edit of the board file never makes anything DONE, and a protected file touched along the way stays off limits. Stop only when every item is verified (`dod verify`), blocked (`dod block` with the reason), or waiting on a decision only the user can make (ask it).",
    ])
  // Independent review gates: a plan the red team still blocks, a foreign
  // checklist review that did not pass, or an unfinished acceptance run all
  // hold the session here, even when the board itself is clean.
  const review = reviewReminder(reviews)
  if (review) return reminder(review)
  const paragraph = text.split(/\n\s*\n/).at(-1)?.trim() ?? ""
  if (PROMISE.test(paragraph))
    return reminder([
      "Completion check: your reply ended by announcing work instead of doing it.",
      "Do that work now with your tools, then report the result. If it cannot be done, say exactly what blocks it.",
    ])
  return undefined
}

function openItems(messages: ReadonlyArray<SessionMessage.Info>, board: Dod.Status, sessionID?: string) {
  return claimedItems(messages, board, sessionID)
    .filter((item) => item.done < item.total)
    .slice(0, 3)
    .map((item) => {
      const left = (board.type === "ready" ? (board.steps?.get(item.id) ?? []) : []).filter((step) => !/^\s*\[x\]/i.test(step)).slice(0, 5)
      return [`- ${item.id} "${item.what}": ${item.done}/${item.total} steps checked.`, ...left.map((step) => `  ${step}`)].join("\n")
    })
}

// Every step checked, still not DONE: only `dod verify` makes an item DONE, with its evidence.
// Without this the session reports the work finished while the board still says otherwise.
function unverifiedItems(messages: ReadonlyArray<SessionMessage.Info>, board: Dod.Status, sessionID?: string) {
  return claimedItems(messages, board, sessionID)
    .filter((item) => item.done >= item.total)
    .slice(0, 3)
    .map(
      (item) =>
        `- ${item.id} "${item.what}": ${item.done}/${item.total} steps checked, but the item is not verified yet. Run \`dod verify\` for it — only verify makes it DONE, with the recorded evidence.`,
    )
}

// Board items this session took or claimed, still open. Shared by the unchecked-steps and
// the not-verified checks, so both hold the session to the same commitments. "This session"
// means the ids its own tool calls named, or the items its session id holds — never another
// worker's items, which share nothing with it but the board.
function claimedItems(messages: ReadonlyArray<SessionMessage.Info>, board: Dod.Status, sessionID?: string) {
  if (board.type !== "ready") return []
  const calls = messages.flatMap((message) =>
    message.type === "assistant" ? tools(message).filter((tool) => tool.name === "dod") : [],
  )
  const inputs = calls.map((tool) =>
    "input" in tool.state && typeof tool.state.input === "object" ? tool.state.input : {},
  )
  if (!inputs.some((input) => WORK_ACTIONS.has(String(input.action)))) return []
  const named = new Set(inputs.flatMap((input) => (typeof input.id === "string" ? [input.id] : [])))
  return board.items.filter(
    (item) =>
      item.state === "IN_PROGRESS" &&
      (named.has(item.id) ||
        (sessionID !== undefined && item.ownerID === sessionID) ||
        (item.owner === AI_OWNER && (item.ownerID === undefined || item.ownerID === AI_OWNER_ID))),
  )
}

// What the model touched with its own hands this turn that only the proper channel may touch:
// the board file (DONE comes only from `dod verify`) and the secret files the room rules
// protect. Only this turn is scanned, so an old touch does not wake every later stop.
function forbiddenTouches(turn: ReadonlyArray<SessionMessage.Info>) {
  const found: Array<string> = []
  const note = (line: string) => {
    if (!found.includes(line)) found.push(line)
  }
  for (const call of turnCalls(turn)) {
    if ((call.name === "edit" || call.name === "write") && typeof call.input.path === "string") {
      if (isBoardFile(call.input.path))
        note(`- The board file ${call.input.path} was edited by hand this turn. A hand edit never makes anything DONE.`)
      const secret = RoomRules.protectedFile(undefined, call.input.path)
      if (secret) note(`- Protected file ${call.input.path} was touched this turn (matches ${secret}).`)
    }
    if (call.name === "patch" && typeof call.input.patchText === "string") {
      if (call.input.patchText.includes("dod.yaml"))
        note("- The board file dod.yaml was edited by hand this turn (patch). A hand edit never makes anything DONE.")
      const secret = RoomRules.protectedFileInCommand(undefined, call.input.patchText)
      if (secret) note(`- A protected file matching ${secret} was touched this turn (patch).`)
    }
    if (call.name === "shell" && typeof call.input.command === "string") {
      if (writesBoard(call.input.command))
        note("- The board file dod.yaml was written by a shell command this turn. A hand edit never makes anything DONE.")
      const secret = RoomRules.protectedFileInCommand(undefined, call.input.command)
      if (secret) note(`- A protected file matching ${secret} was touched by a shell command this turn.`)
      if (RoomRules.commandLeaksCredentials(call.input.command))
        note("- A shell command this turn prints the host's environment or credentials.")
    }
  }
  return found.slice(0, 3)
}

const isBoardFile = (path: string) => /(^|\/)dod\.yaml$/.test(path.replaceAll("\\", "/"))

// A shell command that mentions the board file and writes to it: a redirect, tee, or an
// in-place sed. Reading the board (cat, grep) is not a touch.
const writesBoard = (command: string) =>
  /(^|\/)dod\.yaml/.test(command.replaceAll("\\", "/")) && /(>>?|tee\b|sed\b[^\n]*-i)/.test(command)

/** A short text of the latest turn for the rule judge: its tool calls and its last reply. */
export function turnDigest(messages: ReadonlyArray<SessionMessage.Info>): string {
  const start = messages.findLastIndex((message) => message.type === "user")
  const turn = messages.slice(start + 1)
  const calls = turnCalls(turn)
    .slice(-12)
    .map((call) => `- ${call.name} ${JSON.stringify(call.input).slice(0, 220)}`)
  const last = turn.findLast((message) => message.type === "assistant")
  const said =
    last && last.type === "assistant"
      ? last.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n").trim().slice(0, 1200)
      : ""
  return [`Calls:`, ...(calls.length ? calls : ["- none"]), `Reply: ${said || "(empty)"}`].join("\n")
}

/** How many times the rule judge has already sent this turn back. */
export function judgedCount(messages: ReadonlyArray<SessionMessage.Info>, key: string): number {
  const start = messages.findLastIndex((message) => message.type === "user")
  return messages.slice(start + 1).filter((message) => message.type === "synthetic" && message.metadata?.[key] === true).length
}

function turnCalls(turn: ReadonlyArray<SessionMessage.Info>) {
  return turn.flatMap((message) =>
    message.type === "assistant"
      ? tools(message).map((tool) => ({
          name: tool.name,
          input:
            "input" in tool.state && typeof tool.state.input === "object" && tool.state.input !== null
              ? (tool.state.input as Record<string, unknown>)
              : {},
        }))
      : [],
  )
}

function tools(message: SessionMessage.Assistant) {
  return message.content.filter((part) => part.type === "tool")
}

function reminder(lines: ReadonlyArray<string>) {
  return `<system-reminder>\n${lines.join("\n")}\n</system-reminder>`
}

function hasOutstandingTasks(messages: ReadonlyArray<SessionMessage.Info>, now?: DateTime.DateTime): boolean {
  let dispatched = 0
  let reported = 0
  let lastDispatch = 0
  for (const message of messages) {
    if (message.type === "assistant") {
      for (const part of message.content) {
        if (part.type === "tool" && part.name === "sessions") {
          const input = typeof part.state.input === "object" && part.state.input !== null ? part.state.input : {}
          if ((input as any).action === "send" || ((input as any).action === "create" && (input as any).text)) {
            if (part.state.status === "completed") {
              dispatched++
              lastDispatch = DateTime.toEpochMillis(message.time.created)
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
  if (dispatched <= reported) return false
  // Without a clock the gate cannot tell a fresh dispatch from a stale one; the runner
  // always supplies one, so this only fires for direct callers.
  if (now === undefined) return true
  return DateTime.toEpochMillis(now) - lastDispatch <= STALE_DISPATCH_MS
}
