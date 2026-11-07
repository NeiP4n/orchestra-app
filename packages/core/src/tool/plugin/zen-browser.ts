export * as ZenBrowserTool from "./zen-browser.js"

import { ToolFailure } from "@orchestra/ai"
import type { Context } from "@orchestra/plugin/effect/plugin"
import { optional } from "@orchestra/schema/schema"
import { Effect, Option, Schema } from "effect"
import { DesktopIsolation } from "../../desktop-isolation.js"
import { KV } from "../../kv.js"
import { Permission } from "../../permission.js"
import { Ssrf } from "../ssrf.js"
import { zenBridgeServer, ZenBridgeServer } from "../../zen/bridge-server.js"
import { Idempotency } from "../idempotency.js"

export const name = "zen_browser"

export const description = [
  "Direct interaction with Zen Browser via WebSocket bridge:",
  "view open tabs, read page content, execute JavaScript, click elements, type text, navigate URLs, and control media playback (YouTube, Spotify, SoundCloud, etc.).",
  "",
  "This is the operator's own browser, so every action except status needs the real-screen opt-in (ORCHESTRA_DESKTOP_REAL_SCREEN=on, allowlist naming zen-browser, and a future ORCHESTRA_DESKTOP_REAL_SCREEN_UNTIL). Without it the call is refused.",
  "",
  "Actions:",
  "  status — check connection status with the Zen Browser extension (Orchestra Companion).",
  "  tabs — list all open tabs with their ids, titles, URLs and active state.",
  "  read — read visible text content and metadata of a tab (defaults to active tab).",
  "  eval — execute JavaScript expression or code in a tab (defaults to active tab). Requires 'code'. Only in a tab this session opened with navigate — eval in a tab the operator opened is refused.",
  "  click — click an element matching CSS selector in a tab. Requires 'selector'.",
  "  type — type text into an input element matching CSS selector in a tab. Requires 'selector'.",
  "  navigate — navigate a tab to a specified URL, or open new tab if no tabId. Requires 'url'. The URL must be public (the shared SSRF gate); localhost and LAN addresses are refused unless ORCHESTRA_ZEN_BROWSER_ALLOW_LOCAL_URLS is set for local testing.",
  "  activate — bring a tab to the foreground. Requires 'tabId'.",
  "  close — close a tab. Defaults to active tab or specified 'tabId'.",
  "  media — control media playback (play_pause, play, pause, next, prev, mute).",
].join("\n")

export const Input = Schema.Struct({
  action: Schema.Literals([
    "status",
    "tabs",
    "read",
    "eval",
    "click",
    "type",
    "navigate",
    "activate",
    "close",
    "media",
  ]),
  tabId: optional(Schema.Number),
  url: optional(Schema.String),
  code: optional(Schema.String),
  selector: optional(Schema.String),
  text: optional(Schema.String),
  command: optional(Schema.Literals(["play_pause", "play", "pause", "next", "prev", "mute"])),
})
export type Input = typeof Input.Type

export const Output = Schema.Struct({
  output: Schema.String,
})
export type Output = typeof Output.Type

let currentBridge: ZenBridgeServer = zenBridgeServer

export function setZenBridgeServer(server: ZenBridgeServer): void {
  currentBridge = server
}

export function getZenBridgeServer(): ZenBridgeServer {
  return currentBridge
}

/**
 * Tabs this process opened for a session through `zen_browser navigate`,
 * by session id. `eval` runs JavaScript in the operator's own browser, so
 * it is allowed only in one of these tabs: a tab the operator opened may
 * hold a logged-in service, and running agent code in it would spend the
 * operator's session, not the agent's. The set is in-memory and
 * fail-closed: after a restart no tab is agent-opened until the session
 * navigates to it again.
 */
const agentTabs = new Map<string, Set<number>>()

export function recordAgentTab(sessionID: string, tabId: number): void {
  const tabs = agentTabs.get(sessionID) ?? new Set<number>()
  tabs.add(tabId)
  agentTabs.set(sessionID, tabs)
}

export function isAgentTab(sessionID: string, tabId: number): boolean {
  return agentTabs.get(sessionID)?.has(tabId) ?? false
}

/** Test helper: forget agent-opened tabs, one session or all of them. */
export function clearAgentTabs(sessionID?: string): void {
  if (sessionID === undefined) agentTabs.clear()
  else agentTabs.delete(sessionID)
}

/**
 * Local URLs are refused by the SSRF gate by default: the operator opted
 * into the browser as a whole, not into reading their localhost services.
 * `ORCHESTRA_ZEN_BROWSER_ALLOW_LOCAL_URLS=1` lifts the gate for local
 * testing only — it is never set by default.
 */
export function allowLocalUrls(env: NodeJS.ProcessEnv = process.env): boolean {
  return ["1", "true", "on"].includes(env.ORCHESTRA_ZEN_BROWSER_ALLOW_LOCAL_URLS?.trim().toLowerCase() ?? "")
}

export function validate(input: Input): string | undefined {
  if (input.action === "eval" && !input.code?.trim()) {
    return 'zen_browser action "eval" requires "code"'
  }
  if ((input.action === "click" || input.action === "type") && !input.selector?.trim()) {
    return `zen_browser action "${input.action}" requires "selector"`
  }
  if (input.action === "navigate" && !input.url?.trim()) {
    return 'zen_browser action "navigate" requires "url"'
  }
  return undefined
}

export function renderResult(action: string, result: unknown): string {
  if (action === "eval") {
    const val =
      typeof result === "object" && result !== null && "result" in result
        ? (result as { result: unknown }).result
        : result
    if (val === undefined) return "undefined"
    if (val === null) return "null"
    return typeof val === "object" ? JSON.stringify(val, null, 2) : String(val)
  }

  if (result === undefined || result === null) return "OK"
  if (typeof result === "string") return result

  if (action === "tabs") {
    const list =
      typeof result === "object" && result && "tabs" in result && Array.isArray((result as { tabs: unknown[] }).tabs)
        ? (result as { tabs: unknown[] }).tabs
        : Array.isArray(result)
          ? result
          : null
    if (list) {
      if (list.length === 0) return "No open tabs."
      return [
        `Open tabs (${list.length}):`,
        ...list.map((item) => {
          const tab = item as { id?: number; title?: string; url?: string; active?: boolean }
          const marker = tab.active ? " [active]" : ""
          const id = tab.id !== undefined ? `Tab #${tab.id}` : "Tab"
          const title = tab.title || "(untitled)"
          const url = tab.url ? `\n    ${tab.url}` : ""
          return `* ${id}${marker}: ${title}${url}`
        }),
      ].join("\n")
    }
  }

  if (action === "read" && typeof result === "object" && result) {
    const r = result as { title?: string; url?: string; text?: string; excerpt?: string }
    const parts: string[] = []
    if (r.title) parts.push(`Title: ${r.title}`)
    if (r.url) parts.push(`URL: ${r.url}`)
    if (parts.length > 0) parts.push("---")
    parts.push(r.text || r.excerpt || "(empty page content)")
    return parts.join("\n")
  }

  if (typeof result === "object") {
    return JSON.stringify(result, null, 2)
  }

  return String(result)
}

/** What a zen_browser call touches, for the permission check: the URL it opens, the code it runs, the selector it clicks, or the tab it acts on. */
export function resourcesFor(input: Input): ReadonlyArray<string> {
  switch (input.action) {
    case "navigate":
      return [input.url ?? "*"]
    case "eval":
      return ["eval"]
    case "click":
    case "type":
      return [input.selector ?? "*"]
    case "activate":
    case "close":
    case "read":
      return [input.tabId === undefined ? "*" : `tab:${input.tabId}`]
    default:
      return ["*"]
  }
}

export const run = (input: Input, sessionID: string) =>
  Effect.gen(function* () {
    const bridge = getZenBridgeServer()
    const status = bridge.getStatus()

    if (input.action === "status") {
      if (!status.connected) {
        return {
          output: `Zen Browser bridge is running on port ${bridge.port}, but no Zen Browser extension is currently connected. Ensure Zen Browser is open with Orchestra Companion.`,
        }
      }
      return {
        output: `Zen Browser connected (${status.clientInfo?.client ?? "zen-extension"} v${status.clientInfo?.version ?? "unknown"}) on port ${bridge.port}.`,
      }
    }

    if (!status.connected) {
      return {
        output: `Zen Browser bridge is running on port ${bridge.port}, but no Zen Browser extension is currently connected. Ensure Zen Browser is open with Orchestra Companion.`,
      }
    }

    const invalid = validate(input)
    if (invalid) {
      return yield* new ToolFailure({ message: invalid })
    }

    // Arch3 №5: the real-screen opt-in allows the browser, not any
    // destination. A navigate to a localhost or LAN address would read the
    // operator's own services (including this Orchestra server) through
    // `read`, so the URL passes the shared SSRF gate first.
    if (input.action === "navigate" && input.url !== undefined && !allowLocalUrls()) {
      yield* Ssrf.assertPublicUrl(input.url).pipe(
        Effect.mapError(
          (error) =>
            new ToolFailure({
              message: `zen_browser navigate refused: ${error.message} (set ORCHESTRA_ZEN_BROWSER_ALLOW_LOCAL_URLS=1 to allow local URLs for testing)`,
            }),
        ),
      )
    }

    const params: Record<string, unknown> = {}
    if (input.tabId !== undefined) params.tabId = input.tabId
    if (input.url !== undefined) params.url = input.url
    if (input.code !== undefined) params.code = input.code
    if (input.selector !== undefined) params.selector = input.selector
    if (input.text !== undefined) params.text = input.text
    if (input.command !== undefined) params.command = input.command
    if (input.action === "media" && params.command === undefined) {
      params.command = "play_pause"
    }

    // A navigate without a tab must not open a second tab for a URL that is
    // already open: reuse that tab's id. A failed tab list never blocks the
    // navigation — it falls back to opening as before.
    if (input.action === "navigate" && input.tabId === undefined && input.url !== undefined) {
      const listed = yield* Effect.tryPromise({
        try: () => bridge.sendRpc<{ tabs?: ReadonlyArray<{ id?: number; url?: string }> }>("tabs", {}),
        catch: () => new Error("zen_browser tabs list failed"),
      }).pipe(Effect.option)
      if (Option.isSome(listed)) {
        const target = Idempotency.normalizeTarget(input.url)
        const match = (listed.value.tabs ?? []).find(
          (tab) => tab.id !== undefined && tab.url !== undefined && Idempotency.normalizeTarget(tab.url) === target,
        )
        if (match?.id !== undefined) params.tabId = match.id
      }
    }

    // Arch3 №5: `eval` runs JavaScript in the operator's own browser, and
    // without a tabId the extension runs it in the active tab — which is
    // usually the operator's, possibly logged in somewhere. Only a tab this
    // session opened with navigate may run agent code.
    if (input.action === "eval") {
      if (input.tabId !== undefined) {
        if (!isAgentTab(sessionID, input.tabId))
          return yield* new ToolFailure({
            message: `zen_browser eval refused: tab #${input.tabId} was not opened by this session. Navigate to the URL first, then eval in that tab.`,
          })
      } else {
        const listed = yield* Effect.tryPromise({
          try: () => bridge.sendRpc<{ tabs?: ReadonlyArray<{ id?: number; active?: boolean }> }>("tabs", {}),
          catch: () => new Error("zen_browser tabs list failed"),
        }).pipe(Effect.option)
        const active = Option.isSome(listed)
          ? (listed.value.tabs ?? []).find((tab) => tab.active === true && tab.id !== undefined)
          : undefined
        if (active?.id === undefined || !isAgentTab(sessionID, active.id))
          return yield* new ToolFailure({
            message:
              "zen_browser eval refused: the active tab was not opened by this session. Navigate to the URL first, then eval in that tab.",
          })
        params.tabId = active.id
      }
    }

    const raw = yield* Effect.tryPromise({
      try: () => bridge.sendRpc(input.action, params),
      catch: (error) =>
        new ToolFailure({
          message: `zen_browser ${input.action} failed: ${error instanceof Error ? error.message : String(error)}`,
          error,
        }),
    })

    // A successful navigate opens (or reuses) a tab for this session: that
    // tab may run agent code afterwards. The extension answers navigate
    // with the Tab object, so its id is the direct record; a bridge that
    // answers otherwise is resolved through the tab list instead.
    if (input.action === "navigate" && input.url !== undefined) {
      const direct = typeof raw === "object" && raw !== null && "id" in raw && typeof raw.id === "number" ? raw.id : undefined
      const recorded = direct ?? (typeof params.tabId === "number" ? params.tabId : undefined)
      if (recorded !== undefined) recordAgentTab(sessionID, recorded)
      else {
        const listed = yield* Effect.tryPromise({
          try: () => bridge.sendRpc<{ tabs?: ReadonlyArray<{ id?: number; url?: string }> }>("tabs", {}),
          catch: () => new Error("zen_browser tabs list failed"),
        }).pipe(Effect.option)
        if (Option.isSome(listed)) {
          const target = Idempotency.normalizeTarget(input.url)
          const match = (listed.value.tabs ?? []).find(
            (tab) => tab.id !== undefined && tab.url !== undefined && Idempotency.normalizeTarget(tab.url) === target,
          )
          if (match?.id !== undefined) recordAgentTab(sessionID, match.id)
        }
      }
    }

    return { output: renderResult(input.action, raw) }
  })

/**
 * B7: zen_browser drives the operator's own browser — their tabs, pages,
 * clicks, and typed text. Every action except `status` (which only says
 * whether the bridge is connected) needs the real-screen opt-in for the
 * `zen-browser` app: ORCHESTRA_DESKTOP_REAL_SCREEN=on, an allowlist naming
 * `zen-browser`, and a future ORCHESTRA_DESKTOP_REAL_SCREEN_UNTIL.
 * Returns the refusal message, or undefined when the action may run.
 */
export function deniedByRealScreenGate(input: Input, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (input.action === "status") return undefined
  const denial = DesktopIsolation.realScreenDenial(env, "zen-browser")
  if (denial === undefined) return undefined
  return `zen_browser ${input.action} is blocked: ${denial}`
}

export const Plugin = {
  id: "orchestra.tool.zen-browser",
  effect: Effect.fn("ZenBrowserTool.Plugin")(function* (ctx: Context) {
    const permission = yield* Permission.Service
    // Optional: without a KV store the navigate dedup is skipped, but the
    // tool still works (the desktop plugin requires KV; test layers may not
    // provide it — same pattern as playtest's optional Session service).
    const kv = Option.getOrUndefined(yield* Effect.serviceOption(KV.Service))
    yield* ctx.tool
      .transform((editor) =>
        editor.add({
          name,
          options: { codemode: false, core: true },
          description,
          input: Input,
          output: Output,
          execute: (value, context) =>
            Effect.gen(function* () {
              // B7 gate first: a denied real-screen action never reaches the
              // permission prompt or the bridge.
              const gated = deniedByRealScreenGate(value)
              if (gated) return yield* new ToolFailure({ message: gated })
              // Zen Browser drives the operator's own browser: tabs, pages, clicks, typed
              // text, navigation. Nothing here runs without a permission check — a
              // deny, or an ask the operator refuses, stops the call before the bridge
              // is even touched.
              const resources = resourcesFor(value)
              yield* permission.assert({
                action: name,
                resources: [...resources],
                save: [...resources],
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool" as const, messageID: context.messageID, id: context.id },
              })
              // A navigate is an external action (block B4): the same session
              // navigating to the same URL twice — a crash, a resume, or a
              // model that repeats itself — must not open a second tab.
              // A failed check never blocks the navigation.
              if (value.action === "navigate" && value.url !== undefined && kv !== undefined) {
                const existing = yield* Idempotency.check(kv, {
                  sessionID: context.sessionID,
                  action: "zen_browser navigate",
                  target: value.url,
                }).pipe(Effect.orElseSucceed(() => undefined))
                if (existing !== undefined)
                  return { output: `already open: ${value.url.trim()} (duplicate skipped, opened earlier)` }
                const result = yield* run(value, context.sessionID)
                yield* Idempotency.record(
                  kv,
                  { sessionID: context.sessionID, action: "zen_browser navigate", target: value.url },
                  result.output,
                ).pipe(Effect.ignore)
                return result
              }
              return yield* run(value, context.sessionID)
            }).pipe(
              Effect.map((res) => ({
                output: res,
                content: res.output,
              })),
              Effect.mapError((error) =>
                error instanceof ToolFailure
                  ? error
                  : new ToolFailure({ message: `zen_browser failed: ${String(error)}`, error }),
              ),
            ),
        }),
      )
      .pipe(Effect.orDie)
  }),
}
