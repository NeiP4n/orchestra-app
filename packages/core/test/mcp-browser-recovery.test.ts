import { describe, expect } from "bun:test"
import { Effect, Layer, Stream } from "effect"
import { AppNodeBuilder } from "@orchestra/core/effect/app-node-builder"
import { LayerNode } from "@orchestra/util/effect/layer-node"
import { Bus } from "@orchestra/core/bus"
import { Mcp } from "@orchestra/core/mcp/index"
import { Permission } from "@orchestra/core/permission"
import { Session } from "@orchestra/core/session"
import { Tool } from "@orchestra/core/tool"
import { McpTool } from "@orchestra/core/tool/mcp"
import { Image } from "@orchestra/core/image"
import { executeTool, toolIdentity } from "./lib/tool"
import { testEffect } from "./lib/effect"
import { imagePassthrough } from "./lib/image"

const FRESH_SNAPSHOT = [
  "- RootWebArea 'Example' [uid 2_1]",
  "  - button 'Submit' [uid 2_71]",
  "  - textbox 'Search' [uid 2_72]",
].join("\n")

const tool = (server: string, name: string) =>
  ({
    server: Mcp.ServerName.make(server),
    name,
    description: name,
    // Direct tools (not Code Mode) so the test executes the same leaf the
    // Code Mode `execute` tool dispatches to in production.
    codemode: false,
    inputSchema: { type: "object", properties: {} },
  }) satisfies Mcp.Tool

const calls: Array<{ server: string; name: string; args: Record<string, unknown> }> = []

const result = (server: string, name: string, isError: boolean, text: string): Mcp.ToolResult =>
  ({
    server: Mcp.ServerName.make(server),
    tool: name,
    isError,
    content: [{ type: "text", text }],
  }) satisfies Mcp.ToolResult

const mcp = Layer.mock(Mcp.Service, {
  tools: () =>
    Effect.succeed([
      tool("chrome-devtools", "take_snapshot"),
      tool("chrome-devtools", "click"),
      tool("chrome-devtools", "evaluate"),
      tool("chrome-devtools", "wait_for"),
      tool("playwright", "browser_snapshot"),
      tool("playwright", "browser_click"),
      tool("playwright", "browser_wait_for"),
      tool("plain", "click"),
    ]),
  callTool: (input) =>
    Effect.sync(() => {
      calls.push({ server: String(input.server), name: input.name, args: input.args ?? {} })
      if (input.server === "chrome-devtools" && input.name === "take_snapshot")
        return result(input.server, input.name, false, FRESH_SNAPSHOT)
      if (input.server === "chrome-devtools" && input.name === "click") {
        if ((input.args as { uid?: string }).uid === "2_66")
          return result(input.server, input.name, true, "Error: Element with uid 2_66 no longer exists on the page")
        return result(input.server, input.name, true, "Timeout 30000ms exceeded waiting for element")
      }
      if (input.server === "chrome-devtools" && input.name === "evaluate")
        return result(input.server, input.name, true, "ReferenceError: Unknown identifier 'setTimeout'")
      if (input.server === "playwright" && input.name === "browser_snapshot")
        return result(input.server, input.name, false, FRESH_SNAPSHOT)
      if (input.server === "playwright" && input.name === "browser_click")
        return result(input.server, input.name, true, 'Error: Element with ref "e5" not found')
      if (input.server === "plain" && input.name === "click")
        return result(input.server, input.name, true, "Error: Element with uid 1_9 no longer exists on the page")
      return result(input.server, input.name, false, "ok")
    }),
})

const permissions = Layer.mock(Permission.Service, { assert: () => Effect.void })
const events = Layer.mock(Bus.Service, { subscribe: () => Stream.never })

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Tool.node, McpTool.node]), [
    Mcp.node.replace(mcp),
    Permission.node.replace(permissions),
    Bus.node.replace(events),
    Image.node.replace(imagePassthrough),
  ]),
)

const runTool = (name: string, input: Record<string, unknown>) =>
  Effect.gen(function* () {
    const registry = yield* Tool.Service
    const registration = yield* McpTool.Service
    yield* registration.flush
    return yield* executeTool(registry, {
      sessionID: Session.ID.make("ses_mcp_browser_recovery"),
      ...toolIdentity,
      call: { type: "tool-call", id: `call_${name}`, name, input },
    })
  })

describe("MCP browser recovery: stale element", () => {
  it.effect("a stale chrome-devtools uid returns a fresh snapshot instead of a dead end", () => {
    calls.length = 0
    return Effect.gen(function* () {
      const outcome = yield* runTool("chrome_devtools_click", { uid: "2_66" })
      const text = JSON.stringify(outcome)
      // The step does not die on the stale uid: the failure carries a fresh
      // snapshot taken server-side, so the model retries the click with the
      // new uid in one turn instead of spending a take_snapshot turn first.
      expect(outcome.status).toBe("error")
      expect(text).toContain("2_66")
      expect(text).toContain("no longer exists")
      expect(text).toContain("2_71")
      expect(text).toContain("Fresh snapshot")
      expect(text).toContain("Do not reuse the old uid/ref")
      // The dead uid is never retried; the snapshot was taken once, by the
      // wrapper — not by the model.
      expect(calls.filter((call) => call.name === "click" && call.server === "chrome-devtools")).toHaveLength(1)
      expect(calls.filter((call) => call.name === "take_snapshot")).toHaveLength(1)
    })
  })

  it.effect("a stale playwright ref recovers through browser_snapshot", () => {
    calls.length = 0
    return Effect.gen(function* () {
      const outcome = yield* runTool("playwright_browser_click", { ref: "e5" })
      const text = JSON.stringify(outcome)
      expect(outcome.status).toBe("error")
      expect(text).toContain("2_71")
      expect(text).toContain("Fresh snapshot")
      expect(calls.filter((call) => call.name === "browser_snapshot")).toHaveLength(1)
      expect(calls.filter((call) => call.name === "browser_click")).toHaveLength(1)
    })
  })

  it.effect("a non-stale error passes through without a snapshot call", () => {
    calls.length = 0
    return Effect.gen(function* () {
      const outcome = yield* runTool("chrome_devtools_click", { uid: "2_99" })
      const text = JSON.stringify(outcome)
      expect(outcome.status).toBe("error")
      expect(text).toContain("Timeout 30000ms exceeded")
      expect(text).not.toContain("Fresh snapshot")
      expect(calls.filter((call) => call.name === "take_snapshot")).toHaveLength(0)
    })
  })

  it.effect("without a snapshot tool the stale error still tells the model to re-snapshot", () => {
    calls.length = 0
    return Effect.gen(function* () {
      const outcome = yield* runTool("plain_click", { uid: "1_9" })
      const text = JSON.stringify(outcome)
      expect(outcome.status).toBe("error")
      expect(text).toContain("no longer exists")
      expect(text).toContain("Take a fresh snapshot first")
      expect(calls.filter((call) => call.server === "plain")).toHaveLength(1)
    })
  })
})

describe("MCP browser recovery: timers in evaluate", () => {
  it.effect("setTimeout inside evaluate fails with the wait_for guidance, not the raw sandbox error", () => {
    calls.length = 0
    return Effect.gen(function* () {
      const outcome = yield* runTool("chrome_devtools_evaluate", {
        function: "() => new Promise((resolve) => setTimeout(resolve, 1000))",
      })
      const text = JSON.stringify(outcome)
      expect(outcome.status).toBe("error")
      expect(text).toContain("wait_for")
      expect(text).toContain("setTimeout")
      // No wait is guessed on the model's behalf: the guidance names the
      // tool, the model decides what to wait for.
      expect(calls.filter((call) => call.name === "wait_for")).toHaveLength(0)
    })
  })
})
