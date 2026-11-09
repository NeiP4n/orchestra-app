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

  test("holds a session to the item `dod next` claimed for it", () => {
    const claimed = board(1)
    const status: Dod.Status =
      claimed.type === "ready" ? { ...claimed, items: claimed.items.map((item) => ({ ...item, ownerID: "local-ai" })) } : claimed
    const text = SessionCompletionGate.check(
      [user("ship it"), assistant("", [{ name: "dod", input: { action: "next" } }]), assistant("Done.")],
      status,
    )
    expect(text).toContain('L-1 "Ship the feature": 1/3 steps checked.')
  })

  test("holds a session only to the items its own session id holds", () => {
    const mine: Dod.Status = {
      type: "ready",
      directory: "/project",
      items: [
        {
          id: "L-1",
          what: "Ship the feature",
          stage: "build",
          state: "IN_PROGRESS",
          done: 1,
          total: 3,
          owner: "AI 11111111",
          ownerID: "ses_aaaaaaaaaaaa11111111111111",
        },
      ],
      steps: new Map([["L-1", ["[x] write code", "[ ] add tests", "[ ] run checks"]]]),
    }
    const next = [user("ship it"), assistant("", [{ name: "dod", input: { action: "next" } }]), assistant("Done.")]
    expect(
      SessionCompletionGate.check(next, mine, undefined, "ses_aaaaaaaaaaaa11111111111111"),
    ).toContain('L-1 "Ship the feature": 1/3 steps checked.')
    // Another session's item is not this session's work, even after a `dod next` call.
    expect(SessionCompletionGate.check(next, mine, undefined, "ses_bbbbbbbbbbbb22222222222222")).toBeUndefined()
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

  test("wakes a session that checked every step but never called dod verify", () => {
    const status = board(3)
    const allChecked: Dod.Status =
      status.type === "ready"
        ? { ...status, items: status.items.map((item) => ({ ...item, state: "IN_PROGRESS" as const })) }
        : status
    const text = SessionCompletionGate.check(
      [user("ship it"), assistant("", [{ name: "dod", input: { action: "take", id: "L-1" } }]), assistant("Done.")],
      allChecked,
    )
    expect(text).toContain('L-1 "Ship the feature": 3/3 steps checked, but the item is not verified yet.')
    expect(text).toContain("Run `dod verify` for it")
  })

  test("does not let a hand-edited board file pass as DONE", () => {
    const text = SessionCompletionGate.check(
      [
        user("ship it"),
        assistant("", [{ name: "edit", input: { path: ".orchestra/dod.yaml" } }]),
        assistant("Done."),
      ],
      empty,
    )
    expect(text).toContain("The board file .orchestra/dod.yaml was edited by hand this turn.")
    expect(text).toContain("A hand edit never makes anything DONE.")
  })

  test("flags a shell command that touches a protected file or dumps the environment", () => {
    const env = SessionCompletionGate.check(
      [user("check the setup"), assistant("", [{ name: "shell", input: { command: "cat .env" } }]), assistant("Done.")],
      empty,
    )
    expect(env).toContain("A protected file matching .env* was touched by a shell command this turn.")
    const dump = SessionCompletionGate.check(
      [user("check the setup"), assistant("", [{ name: "shell", input: { command: "printenv" } }]), assistant("Done.")],
      empty,
    )
    expect(dump).toContain("prints the host's environment or credentials")
  })

  test("escalates once when the board still holds work after the nudge limit", () => {
    const work = () => assistant("", [{ name: "read", input: { path: "a" } }])
    const messages = [
      user("ship it"),
      assistant("", [{ name: "dod", input: { action: "take", id: "L-1" } }]),
      nudge(),
      work(),
      nudge(),
      work(),
      nudge(),
      work(),
      assistant("Done."),
    ]
    const text = SessionCompletionGate.check(messages, board(1))
    expect(text).toContain("final")
    expect(text).toContain('L-1 "Ship the feature"')
    expect(text).toContain("dod block")
  })

  test("stops after the escalation was sent", () => {
    const work = () => assistant("", [{ name: "read", input: { path: "a" } }])
    const messages = [
      user("ship it"),
      assistant("", [{ name: "dod", input: { action: "take", id: "L-1" } }]),
      nudge(),
      work(),
      nudge(),
      work(),
      nudge(),
      work(),
      nudge(),
      work(),
      assistant("Done."),
    ]
    expect(SessionCompletionGate.check(messages, board(1))).toBeUndefined()
  })

  test("wakes a session whose team task went stale without a report", () => {
    const dispatch = assistant("Dispatched worker.", [
      { name: "dod", input: { action: "take", id: "L-1" } },
      { name: "sessions", input: { action: "send", sessionID: "ses_worker", text: "do work" } },
    ])
    const waiting = [user("ship it"), dispatch, assistant("Worker was dispatched, waiting.")]
    // A fresh dispatch is still outstanding: the report may yet arrive.
    expect(
      SessionCompletionGate.check(waiting, board(1), DateTime.makeUnsafe(60_000)),
    ).toBeUndefined()
    // Half an hour with no report means the worker is gone or stuck: wake the session to
    // check on it instead of idling forever with an unclosed board item.
    expect(
      SessionCompletionGate.check(waiting, board(1), DateTime.makeUnsafe(31 * 60_000)),
    ).toContain('L-1 "Ship the feature"')
  })

  test("does not nudge while a team subagent task is outstanding", () => {
    const dispatch = assistant("Dispatched worker.", [
      { name: "dod", input: { action: "take", id: "L-1" } },
      { name: "sessions", input: { action: "send", sessionID: "ses_worker", text: "do work" } },
    ])
    // Still waiting for team report, so should NOT nudge even though DoD board has open items
    expect(SessionCompletionGate.check([user("ship it"), dispatch], board(1))).toBeUndefined()

    // Once team report arrives, if item is still open and assistant replies without finishing, it can nudge
    const report: SessionMessage.Info = {
      type: "synthetic",
      id: id(),
      time,
      text: '<team-report worker="Worker">Done with task</team-report>',
      metadata: { source: "team" },
    }
    const afterReport = [user("ship it"), dispatch, report, assistant("Worker finished, but steps remain.")]
    expect(SessionCompletionGate.check(afterReport, board(1))).toContain('L-1 "Ship the feature"')
  })
})

describe("SessionCompletionGate: BrowserAgent", () => {
  const BA = "team-browser-agent"
  const run = (messages: SessionMessage.Info[]) => SessionCompletionGate.check(messages, empty, undefined, undefined, undefined, BA)
  const search = { name: "websearch", input: { query: "x" } }
  const browser = { name: "browser", input: { action: "snapshot" } }

  test("sends it back to the page when it stops after a search without using the browser", () => {
    const text = run([user("open muse.ai"), assistant("", [search]), assistant("")])
    expect(text).toContain("You have not used the browser tool yet")
  })
  test("sends it back when it used the browser but ended without a state line", () => {
    const text = run([user("open muse.ai"), assistant("", [browser]), assistant("I looked at it.")])
    expect(text).toContain("Continue in the browser")
  })
  test("lets a report that starts with a state line stand, after real page work", () => {
    expect(run([user("open muse.ai"), assistant("", [browser]), assistant("DONE\nOpened muse.ai.")])).toBeUndefined()
  })
  test("a DONE without any browser call is not believed, a NOT DONE is", () => {
    expect(run([user("open muse.ai"), assistant("DONE\nTrust me.")])).toContain("You have not used the browser tool yet")
    expect(run([user("open muse.ai"), assistant("NOT DONE\nChrome would not start.")])).toBeUndefined()
  })
  test("when the reminders are spent it asks for an explicit NOT DONE once, then lets it stop", () => {
    const spent = [user("open muse.ai"), assistant("", [search]), nudge(), assistant(""), nudge(), assistant(""), nudge(), assistant("")]
    expect(run(spent)).toContain("Completion check (final)")
    expect(run([...spent, nudge(), assistant("")])).toBeUndefined()
  })
})

describe("SessionCompletionGate: giving up", () => {
  const worker = (messages: SessionMessage.Info[]) => SessionCompletionGate.check(messages, empty, undefined, undefined, undefined, "team-developer")
  test("a worker that says it cannot, without looking anything up, is sent back", () => {
    expect(worker([user("fix it"), assistant("Я не знаю, как это сделать.")])).toContain("giving up without trying")
  })
  test("a give-up after a search or a question stands", () => {
    expect(worker([user("fix it"), assistant("", [{ name: "websearch", input: { query: "x" } }]), assistant("I cannot find it.")])).toBeUndefined()
    expect(worker([user("fix it"), assistant("", [{ name: "question", input: {} }]), assistant("не смог")])).toBeUndefined()
  })
  test("an ordinary answer is left alone", () => {
    expect(worker([user("fix it"), assistant("Done: the bug was in parse().")])).toBeUndefined()
  })
  test("the nudges are limited", () => {
    const spent = [user("fix it"), assistant("не знаю"), nudge(), assistant("не знаю"), nudge(), assistant("не знаю"), nudge(), assistant("не знаю")]
    expect(worker(spent)).toBeUndefined()
  })
})

describe("SessionCompletionGate: open worker reports", () => {
  const report = (outcome: string): SessionMessage.Info => ({
    type: "synthetic",
    id: id(),
    time,
    text: `<team-report session="s1" outcome="${outcome}">could not finish</team-report>`,
  })
  const orchestrator = (messages: SessionMessage.Info[]) => SessionCompletionGate.check(messages, empty, undefined, undefined, undefined, "orchestrator")
  test("a partial report with no follow-up sends the Orchestrator back", () => {
    expect(orchestrator([user("build it"), report("partial"), assistant("The worker could not finish; telling you.")])).toContain("Do not hand this to the operator yet")
  })
  test("a follow-up sent to a worker satisfies it", () => {
    expect(orchestrator([user("build it"), report("failed"), assistant("", [{ name: "sessions", input: { action: "send" } }]), assistant("Sent it on.")])).toBeUndefined()
  })
  test("a complete report is left alone", () => {
    expect(orchestrator([user("build it"), report("complete"), assistant("All done.")])).toBeUndefined()
  })
  test("the reminders are limited", () => {
    const spent = [user("build it"), report("partial"), assistant("x"), nudge(), assistant("x"), nudge(), assistant("x"), nudge(), assistant("x")]
    expect(orchestrator(spent)).toBeUndefined()
  })
})
