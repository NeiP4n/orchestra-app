import { expect, test } from "bun:test"
import type { SessionMessageAssistant, SessionMessageInfo, SessionMessageUser } from "@orchestra/client/promise"
import { followUpActions, followUpVisible, lastFollowUpAnswer } from "./follow-up"

const user = (id: string): SessionMessageUser => ({ id, type: "user", text: id, time: { created: 0 } })

const assistant = (
  id: string,
  text: string,
  extra?: Partial<SessionMessageAssistant>,
): SessionMessageAssistant => ({
  id,
  type: "assistant",
  time: { created: 0, completed: 1 },
  agent: "build",
  model: { id: "model", providerID: "provider" },
  content: text ? [{ type: "text", text }] : [],
  ...extra,
})

test("lastFollowUpAnswer returns the newest completed assistant text", () => {
  const messages: SessionMessageInfo[] = [user("msg_1"), assistant("msg_2", "first"), assistant("msg_3", "second")]

  expect(lastFollowUpAnswer(messages)).toEqual({ messageID: "msg_3", text: "second" })
})

test("lastFollowUpAnswer joins text parts and skips reasoning and tool content", () => {
  const message = assistant("msg_2", "")
  message.content = [
    { type: "reasoning", text: "thinking" },
    { type: "text", text: "part one" },
    { type: "text", text: "part two" },
  ]

  expect(lastFollowUpAnswer([user("msg_1"), message])).toEqual({
    messageID: "msg_2",
    text: "part one\n\npart two",
  })
})

test("lastFollowUpAnswer hides once the user replies after the answer", () => {
  const messages: SessionMessageInfo[] = [assistant("msg_1", "answer"), user("msg_2")]

  expect(lastFollowUpAnswer(messages)).toBeUndefined()
})

test("lastFollowUpAnswer ignores unfinished, errored, and textless answers", () => {
  expect(lastFollowUpAnswer([assistant("msg_1", "draft", { time: { created: 0 } })])).toBeUndefined()
  expect(
    lastFollowUpAnswer([
      assistant("msg_1", "draft", {
        error: { type: "unknown", message: "boom" } as SessionMessageAssistant["error"],
      }),
    ]),
  ).toBeUndefined()
  expect(lastFollowUpAnswer([assistant("msg_1", "")])).toBeUndefined()
  expect(lastFollowUpAnswer([])).toBeUndefined()
})

test("followUpActions always offers continue, details, plan, and risks", () => {
  expect(followUpActions("short answer")).toEqual(["continue", "details", "plan", "risks"])
})

test("followUpActions puts summarize first for long answers", () => {
  const actions = followUpActions("x".repeat(1200))

  expect(actions[0]).toBe("summarize")
  expect(actions).toContain("continue")
})

test("followUpActions offers explainCode only when the answer contains a code fence", () => {
  expect(followUpActions("run ```ts\ncode\n```")).toContain("explainCode")
  expect(followUpActions("no code here")).not.toContain("explainCode")
})

test("followUpVisible requires an idle, unblocked parent session with an undismissed answer", () => {
  const answer = { messageID: "msg_1", text: "answer" }
  const base = { answer, working: false, blocked: false, child: false, dismissedMessageID: undefined }

  expect(followUpVisible(base)).toBe(true)
  expect(followUpVisible({ ...base, answer: undefined })).toBe(false)
  expect(followUpVisible({ ...base, working: true })).toBe(false)
  expect(followUpVisible({ ...base, blocked: true })).toBe(false)
  expect(followUpVisible({ ...base, child: true })).toBe(false)
  expect(followUpVisible({ ...base, dismissedMessageID: "msg_1" })).toBe(false)
  expect(followUpVisible({ ...base, dismissedMessageID: "msg_0" })).toBe(true)
})
