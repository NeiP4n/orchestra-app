import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { ToolDefinition } from "@orchestra/ai"
import { Agent } from "@orchestra/core/agent"
import { SessionMessage } from "@orchestra/schema/session-message"
import { ToolPruning } from "@orchestra/core/session/tool-pruning"
import { Tool } from "@orchestra/core/tool"

let n = 0

const user = (text: string) =>
  Schema.decodeUnknownSync(SessionMessage.User)({
    id: SessionMessage.ID.make(`msg_user_${++n}`),
    type: "user",
    text,
    time: { created: 0 },
  })

const assistant = (calls: Array<string>, text = "") =>
  Schema.decodeUnknownSync(SessionMessage.Assistant)({
    id: SessionMessage.ID.make(`msg_ast_${++n}`),
    type: "assistant",
    agent: Agent.defaultID,
    model: { id: "test-model", providerID: "test" },
    content: [
      ...(text === "" ? [] : [{ type: "text", text }]),
      ...calls.map((name) => ({
        type: "tool",
        id: `call_${++n}`,
        name,
        state: { status: "completed", input: {}, content: [{ type: "text", text: "ok" }] },
        time: { created: 0 },
      })),
    ],
    time: { created: 0 },
  })

const snapshot = (names: Array<string>): Tool.Snapshot => ({
  definitions: names.map((name) =>
    ToolDefinition.make({ name, description: `${name} tool`, inputSchema: { type: "object" } }),
  ),
  execute: () => Effect.die("unused"),
})

const names = (tools: Tool.Snapshot) => tools.definitions.map((definition) => definition.name)

describe("ToolPruning pruneTools", () => {
  test("a cold session keeps every tool: nothing has had time to go unused", () => {
    const messages = [user("fix the login"), assistant(["read"])]
    const { tools, pruned } = ToolPruning.pruneTools(snapshot(["read", "edit", "shell", "grep"]), messages)

    expect(pruned).toEqual([])
    expect(names(tools)).toEqual(["read", "edit", "shell", "grep"])
  })

  test("a tool unused for 10 turns is pruned; a tool called on turn 9 stays", () => {
    const messages: Array<SessionMessage.Info> = [user("fix the login")]
    for (let turn = 1; turn <= 10; turn += 1) {
      messages.push(assistant(turn === 9 ? ["read"] : ["edit"]))
    }
    const { tools, pruned } = ToolPruning.pruneTools(snapshot(["read", "edit", "shell", "grep"]), messages)

    expect(pruned).toEqual(["shell", "grep"])
    expect(names(tools)).toEqual(["read", "edit"])
  })

  test("a tool named in the latest user message comes back even after 10 unused turns", () => {
    const messages: Array<SessionMessage.Info> = [user("fix the login")]
    for (let turn = 1; turn <= 10; turn += 1) {
      messages.push(assistant(["edit"]))
    }
    messages.push(user("now check it with grep"))
    const { tools, pruned } = ToolPruning.pruneTools(snapshot(["read", "edit", "shell", "grep"]), messages)

    expect(pruned).toEqual(["read", "shell"])
    expect(names(tools)).toEqual(["edit", "grep"])
  })

  test("a tool the model itself names in its latest text is kept", () => {
    const messages: Array<SessionMessage.Info> = [user("fix the login")]
    for (let turn = 1; turn <= 10; turn += 1) {
      messages.push(assistant(["edit"]))
    }
    messages.push(assistant([], "I will run shell to verify"))
    const { tools, pruned } = ToolPruning.pruneTools(snapshot(["read", "edit", "shell", "grep"]), messages)

    expect(pruned).toEqual(["read", "grep"])
    expect(names(tools)).toEqual(["edit", "shell"])
  })

  test("execute and tools are never pruned: hiding them would blind the session", () => {
    const messages: Array<SessionMessage.Info> = [user("fix the login")]
    for (let turn = 1; turn <= 20; turn += 1) {
      messages.push(assistant(["edit"]))
    }
    const { tools, pruned } = ToolPruning.pruneTools(snapshot(["read", "edit", "execute", "tools"]), messages)

    expect(pruned).toEqual(["read"])
    expect(names(tools)).toEqual(["edit", "execute", "tools"])
  })

  test("mode-required tools are never pruned", () => {
    const messages: Array<SessionMessage.Info> = [user("fix the login")]
    for (let turn = 1; turn <= 10; turn += 1) {
      messages.push(assistant(["edit"]))
    }
    const { tools, pruned } = ToolPruning.pruneTools(snapshot(["read", "edit", "dod"]), messages, {
      protectedNames: ["dod"],
    })

    expect(pruned).toEqual(["read"])
    expect(names(tools)).toEqual(["edit", "dod"])
  })

  test("a custom threshold is honoured, and 0 switches pruning off", () => {
    const messages: Array<SessionMessage.Info> = [user("fix the login")]
    for (let turn = 1; turn <= 5; turn += 1) {
      messages.push(assistant(["edit"]))
    }
    const prunedAt3 = ToolPruning.pruneTools(snapshot(["read", "edit"]), messages, { unusedSteps: 3 })
    expect(prunedAt3.pruned).toEqual(["read"])

    const off = ToolPruning.pruneTools(snapshot(["read", "edit"]), messages, { unusedSteps: 0 })
    expect(off.pruned).toEqual([])
    expect(names(off.tools)).toEqual(["read", "edit"])
  })

  test("a pruned tool returns when the session calls it again: history is the state", () => {
    const messages: Array<SessionMessage.Info> = [user("fix the login")]
    for (let turn = 1; turn <= 10; turn += 1) {
      messages.push(assistant(["edit"]))
    }
    const first = ToolPruning.pruneTools(snapshot(["read", "edit"]), messages)
    expect(first.pruned).toEqual(["read"])

    // The operator asked for it by name, the model called it, and the call
    // is now in history: the next step advertises it again.
    messages.push(user("use read now"))
    messages.push(assistant(["read"]))
    const second = ToolPruning.pruneTools(snapshot(["read", "edit"]), messages)
    expect(second.pruned).toEqual([])
    expect(names(second.tools)).toEqual(["read", "edit"])
  })
})

describe("ToolPruning for the Orchestrator", () => {
  const long = () => {
    const messages: Array<SessionMessage.Info> = [user("look at the browser")]
    for (let turn = 1; turn <= 14; turn += 1) messages.push(assistant(["desktop"]))
    return messages
  }
  const all = ["desktop", "mcp_manager", "sessions", "browser", "execute", "tools"]

  test("an ordinary agent loses tools it has not called for 10 turns", () => {
    const { tools } = ToolPruning.pruneTools(snapshot(all), long(), { agent: "build" })
    expect(names(tools)).not.toContain("mcp_manager")
  })

  test("the orchestrator in auto mode keeps core tools and browser however long the session is", () => {
    const { tools, pruned } = ToolPruning.pruneTools(snapshot(all), long(), { agent: "orchestrator" })
    expect(pruned).toEqual([])
    expect(names(tools)).toEqual(all)
  })
})


test("core glob remains advertised to a long-running worker after unrelated edits",()=>{
 const messages:SessionMessage.Info[]=[user("Continue implementation")]
 for(let index=0;index<30;index++)messages.push(assistant(["edit"]))
 const result=ToolPruning.pruneTools(snapshot(["glob","edit","desktop"]),messages,{agent:"team-developer"})
 expect(names(result.tools)).toContain("glob")
 expect(result.pruned).toContain("desktop")
})
