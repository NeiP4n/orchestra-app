import { describe, expect, test } from "bun:test"
import { Agent } from "@orchestra/schema/agent"
import { Model } from "@orchestra/schema/model"
import { Provider } from "@orchestra/schema/provider"
import type { Dod } from "@orchestra/core/dod"
import { SessionCompletionGate } from "@orchestra/core/session/completion-gate"
import { SessionMessage } from "@orchestra/core/session/message"
import { DateTime } from "effect"

const time = { created: DateTime.makeUnsafe(0) }
let counter = 0
const id = () => SessionMessage.ID.make(`msg_gate_${counter++}`)

const user = (text: string): SessionMessage.Info => ({ type: "user", id: id(), time, text, files: [], agents: [] })

const assistant = (
  text: string,
  calls: ReadonlyArray<{ name: string; input: Record<string, unknown> }> = [],
): SessionMessage.Info => ({
  type: "assistant",
  id: id(),
  time,
  agent: Agent.ID.make("build"),
  model: Model.Ref.make({ id: Model.ID.make("m"), providerID: Provider.ID.make("p") }),
  finish: calls.length > 0 ? "tool-calls" : "stop",
  content: [
    ...calls.map((call, index) => ({
      type: "tool" as const,
      id: `call_${index}`,
      name: call.name,
      time,
      state: { status: "completed" as const, input: call.input, content: [{ type: "text" as const, text: "ok" }] as const },
    })),
    ...(text ? [{ type: "text" as const, text }] : []),
  ],
})

const nudge = (): SessionMessage.Info => ({
  type: "synthetic",
  id: id(),
  time,
  text: "<system-reminder>Completion check</system-reminder>",
  metadata: { [SessionCompletionGate.MetadataKey]: true },
})

const board = (done: number): Dod.Status => ({
  type: "ready",
  directory: "/project",
  items: [{ id: "L-1", what: "Ship the feature", stage: "build", state: done === 3 ? "DONE" : "IN_PROGRESS", done, total: 3, owner: "AI" }],
  steps: new Map([["L-1", ["[x] write code", "[ ] add tests", "[ ] run checks"]]]),
})
const empty: Dod.Status = { type: "disabled", directory: "/project" }

describe("SessionCompletionGate", () => {
  test("wakes a session that stops with board steps it took still open", () => {
    const text = SessionCompletionGate.check(
      [user("ship it"), assistant("", [{ name: "dod", input: { action: "take", id: "L-1" } }]), assistant("Done.")],
      board(1),
    )
    expect(text).toContain('L-1 "Ship the feature": 1/3 steps checked.')
    expect(text).toContain("[ ] add tests")
  })

  test("lets a session stop when its item is finished or it never used the board", () => {
    const took = [user("ship it"), assistant("", [{ name: "dod", input: { action: "take", id: "L-1" } }]), assistant("Done.")]
    expect(SessionCompletionGate.check(took, board(3))).toBeUndefined()
    expect(SessionCompletionGate.check([user("hi"), assistant("Hello!")], board(1))).toBeUndefined()
  })

  test("wakes a reply that ends with a promise instead of the work", () => {
    expect(SessionCompletionGate.check([user("fix it"), assistant("Found the bug.\n\nNow I will fix it.")], empty)).toContain(
      "announcing work",
    )
    expect(SessionCompletionGate.check([user("почини"), assistant("Нашла причину.\n\nСейчас исправлю.")], empty)).toContain(
      "announcing work",
    )
  })

  test("lets a session stop to ask the operator", () => {
    expect(SessionCompletionGate.check([user("fix it"), assistant("Next I can rewrite it. Should I?")], empty)).toBeUndefined()
  })

  test("believes a session that answers a nudge without doing anything", () => {
    expect(
      SessionCompletionGate.check([user("fix it"), assistant("Now I will fix it."), nudge(), assistant("Now I will fix it.")], empty),
    ).toBeUndefined()
  })

  test("stops nudging after the per-turn limit", () => {
    const work = () => assistant("", [{ name: "read", input: { path: "a" } }])
    const messages = [user("fix it"), nudge(), work(), nudge(), work(), nudge(), work(), assistant("Now I will fix it.")]
    expect(SessionCompletionGate.check(messages, empty)).toBeUndefined()
  })
})
