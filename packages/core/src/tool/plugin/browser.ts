export * as BrowserTool from "./browser.js"

import { ToolFailure } from "@orchestra/ai"
import type { Context } from "@orchestra/plugin/effect/plugin"
import { optional } from "@orchestra/schema/schema"
import { Effect, Schema } from "effect"
import { BrowserBridge } from "../../browser/bridge.js"
import { BrowserPage } from "../../browser/page.js"
import { BrowserRuntime } from "../../browser/runtime.js"
import { Cdp } from "../../browser/cdp.js"
import { Chrome } from "../../browser/chrome.js"
import { Permission } from "../../permission.js"

export const name = "browser"

// The first sentence is the line in the on-demand tools index, so it says when to reach for this tool.
export const description = [
  "Use this, not desktop_inspect, to see and drive any page: open, click, type, cookies, sign-up.",
  "First choice for ANY work on a website or form, never powershell, fetch, curl or execute: it acts in the operator's Browser tab, so they watch it happen. It sees and drives the page the user sees there.",
  "It is the browser session the operator has selected for this project in the Browser tab: the same Chrome the operator sees there, on its own profile, so logins made in it are real and your clicks act with those accounts. You never launch a browser of your own: this one starts if it is not running.",
  "",
  "Actions:",
  "  open — go to an http or https address (url), then return the page title, address and text.",
  "  text — the visible text of the current page.",
  "  info — the current address and title only.",
  "  screenshot — a picture of the page (shown as an image when the model supports images, with the address and title as text otherwise).",
  "  start — turn the session on: start its Chrome if it is not running (no page change). stop — turn it off: close its Chrome; the profile and logins stay, start brings it back.",
  "  sessions — list every browser session (id, name, project, running or not, page, controller), so you know what exists.",
  "  assign — give a session to another agent (`agent`: its name) so only it may act there; tell that agent the session id. release — take the assignment away.",
  "  click — click the element matching a CSS selector, or the clickable element whose text contains `text`.",
  "  type — put `text` into the field matching `selector`; submit: true presses Enter afterwards.",
  "",
  "Address a session other than the selected one with `session` (its id or name). A session held by another agent, or by the operator in Take control, refuses you.",
  "",
  "Read the page text first and pick targets from it. open, click and type ask the operator for permission. Stop and tell the operator before entering payment details, passwords, or anything that publishes or spends.",
].join("\n")

/** Words that load this tool: the browser itself, and the ways a person asks whether you can see their page. */
export const triggers = [
  "браузер|browser|сайт|страниц[уаы]|web ?page|website",
  "зарегистр|регистрац|sign ?up|register|log ?in|войд[иу]|залогин|cookie|куки|кликни|нажми|заполни|форм[ауе]|аккаунт|account|click|fill (in|out)",
  "ты видишь|видишь (это|меня|страницу|экран)|что (я )?(вижу|открыт)|что на (экране|странице|сайте)|посмотри|открой (сайт|страниц|ссылк)|can you see|do you see|what('s| is) on (my|the) (screen|page)|look at (my|the) (page|browser|tab)",
]

export const Input = Schema.Struct({
  action: Schema.Literals([
    "open",
    "text",
    "info",
    "screenshot",
    "click",
    "type",
    "sessions",
    "assign",
    "release",
    "start",
    "stop",
  ]),
  session: optional(
    Schema.String.annotate({
      description: "Browser session id or name; default is the one selected in the Browser tab",
    }),
  ),
  agent: optional(Schema.String.annotate({ description: "Agent name to give the session to, for assign" })),
  url: optional(Schema.String.annotate({ description: "http or https address, for open" })),
  selector: optional(Schema.String.annotate({ description: "CSS selector, for click and type" })),
  text: optional(Schema.String.annotate({ description: "Text to type, or text of the element to click" })),
  submit: optional(Schema.Boolean.annotate({ description: "Press Enter after typing" })),
})
export type Input = typeof Input.Type

export const Output = Schema.Struct({ output: Schema.String })
export type Output = typeof Output.Type

/** Actions that change the page or act with the operator's logged-in accounts ask first. */
export const acts = (action: Input["action"]) =>
  action === "open" || action === "click" || action === "type" || action === "start" || action === "stop"

/** Actions that only manage which agent holds a session; they never touch the page. */
export const manages = (action: Input["action"]) => action === "sessions" || action === "assign" || action === "release"

const TEXT_LIMIT = 12_000

const page = (info: { url: string; title: string }, text: string) =>
  [
    `${info.title || "(no title)"} - ${info.url}`,
    "",
    text.length > TEXT_LIMIT ? `${text.slice(0, TEXT_LIMIT)}\n[cut]` : text,
  ].join("\n")

export const NO_SESSION =
  "No browser session is selected for this project. Ask the operator to open the Browser tab and add or pick a browser session."

// A short pause so a page that just navigated or reacted has started to render before it is read.
const settle = () => new Promise((done) => setTimeout(done, 1500))

/** A closed connection (Chrome died, or was killed with the app) is dropped and the action tried once more on a fresh one. */
export async function perform(sessionID: string, input: Input) {
  try {
    return await performOnce(sessionID, input)
  } catch (error) {
    if (!/connection (closed|failed)|Could not connect to Chrome/i.test(error instanceof Error ? error.message : String(error)))
      throw error
    // The Chrome this call talked to went away (killed, closed, or restarted into the pane's window mode). open() waits
    // for a restart in progress and joins the Chrome that runs now; a dead stored connection is dropped first.
    for (let attempt = 1; ; attempt++) {
      BrowserRuntime.trace(`browser ${input.action}: connection lost, reconnecting (try ${attempt})`)
      BrowserRuntime.evictIfClosed(sessionID)
      await new Promise((done) => setTimeout(done, 700 * attempt))
      try {
        return await performOnce(sessionID, input)
      } catch (again) {
        if (attempt >= 2 || !/connection (closed|failed)|Could not connect to Chrome/i.test(again instanceof Error ? again.message : String(again)))
          throw again
      }
    }
  }
}

async function performOnce(sessionID: string, input: Input) {
  // Closing must not first start the Chrome it is about to close.
  if (input.action === "stop") {
    const was = BrowserRuntime.isOpen(sessionID)
    BrowserRuntime.close(sessionID)
    return {
      text: was
        ? "Browser session closed. Its profile and logins are kept; start brings it back."
        : "Browser session was not running.",
    }
  }
  const client = await BrowserRuntime.open(sessionID)
  switch (input.action) {
    case "start": {
      const info = await Cdp.pageInfo(client)
      return { text: `Browser session is running: ${info.title || "(no title)"} - ${info.url}` }
    }
    case "open": {
      if (!input.url) throw new Error("open needs a url.")
      await Cdp.navigate(client, Chrome.normalizeUrl(input.url))
      await settle()
      return { text: page(await Cdp.pageInfo(client), await Cdp.pageText(client)) }
    }
    case "text":
      return { text: page(await Cdp.pageInfo(client), await Cdp.pageText(client)) }
    case "info": {
      const info = await Cdp.pageInfo(client)
      return { text: `${info.title || "(no title)"} - ${info.url}` }
    }
    case "screenshot": {
      const info = await Cdp.pageInfo(client)
      return { text: `Screenshot of ${info.title || "(no title)"} - ${info.url}`, png: await Cdp.screenshot(client) }
    }
    case "click": {
      const result = await evaluate(client, BrowserPage.clickExpression({ selector: input.selector, text: input.text }))
      if (!result.ok) throw new Error(result.error ?? "Click failed.")
      BrowserRuntime.pointAgent(sessionID, result.at)
      await settle()
      return {
        text: `Clicked ${result.tag}${result.text ? ` "${result.text}"` : ""}.\n\n${page(await Cdp.pageInfo(client), await Cdp.pageText(client))}`,
      }
    }
    case "type": {
      if (!input.selector || input.text === undefined) throw new Error("type needs a selector and a text.")
      const result = await evaluate(client, BrowserPage.typeExpression({ selector: input.selector, text: input.text }))
      if (!result.ok) throw new Error(result.error ?? "Typing failed.")
      BrowserRuntime.pointAgent(sessionID, result.at)
      if (input.submit) {
        for (const type of ["keyDown", "keyUp"])
          await client.send("Input.dispatchKeyEvent", {
            type,
            key: "Enter",
            code: "Enter",
            windowsVirtualKeyCode: 13,
            text: type === "keyDown" ? "\r" : undefined,
          })
        await settle()
      }
      return { text: `Typed into ${result.tag}${input.submit ? " and pressed Enter" : ""}.` }
    }
    case "sessions":
    case "assign":
    case "release":
      throw new Error(`${input.action} is handled before the page is touched.`)
  }
}

async function evaluate(client: Cdp.Client, expression: string) {
  const reply = await client.send<{ result?: { value?: BrowserPage.Outcome }; exceptionDetails?: { text?: string } }>(
    "Runtime.evaluate",
    { expression, returnByValue: true },
  )
  if (reply.exceptionDetails) throw new Error(reply.exceptionDetails.text ?? "The page script failed.")
  return reply.result?.value ?? { ok: false, error: "The page returned nothing." }
}

export const Plugin = {
  id: "orchestra.tool.browser",
  effect: Effect.fn("BrowserTool.Plugin")(function* (ctx: Context) {
    const permission = yield* Permission.Service

    // The browser session to act in: the one named by `session` (id or name), else the project's selected one,
    // found from the directory this chat works in.
    const sessionFor = Effect.fn("BrowserTool.sessionFor")(function* (
      sessionID: Parameters<typeof ctx.session.get>[0]["sessionID"],
      ref: string | undefined,
    ) {
      const session = yield* ctx.session.get({ sessionID })
      if (ref !== undefined && ref.trim() !== "") {
        const found = BrowserBridge.resolve(BrowserRuntime.sessions(), ref, session.location.directory)
        return "error" in found ? yield* Effect.fail(new ToolFailure({ message: found.error })) : found.session.id
      }
      const published = BrowserRuntime.sessions()
      // A folder with no session of its own uses the only one the Browser tab has, so the chat is not left blind.
      const chosen =
        BrowserRuntime.selectedSession(session.location.directory) ??
        (BrowserBridge.projectOf(published, session.location.directory) === undefined && published.length === 1
          ? published[0]!.id
          : undefined)
      return chosen === undefined ? yield* Effect.fail(new ToolFailure({ message: NO_SESSION })) : chosen
    })

    const fail = (message: string) => Effect.fail(new ToolFailure({ message }))

    yield* ctx.tool
      .transform((editor) =>
        editor.add({
          name,
          options: {
            codemode: false,
            permission: name,
            triggers,
          },
          description,
          input: Input,
          output: Output,
          execute: (input, context) =>
            Effect.gen(function* () {
              const caller = String(context.agent)
              if (input.action === "sessions") {
                const list = BrowserRuntime.sessions()
                const held = BrowserRuntime.leases()
                const pages = new Map<string, { running: boolean; title?: string; url?: string }>()
                for (const item of list) pages.set(item.id, yield* Effect.promise(() => BrowserRuntime.peek(item.id)))
                const text = BrowserBridge.describe(list, held, (id) => pages.get(id) ?? { running: false })
                return { output: { output: text }, content: [{ type: "text" as const, text }] }
              }
              const browserSession = yield* sessionFor(context.sessionID, input.session)
              // Handing a session over or taking it back is the orchestrator's call: only the operator's
              // Take control stops it. Acting in the page is for the assigned agent alone.
              const holder = BrowserRuntime.leases()[browserSession]?.agent
              const managing = input.action === "assign" || input.action === "release"
              const blocked = BrowserBridge.refusal(
                BrowserRuntime.leases(),
                browserSession,
                managing && holder ? holder : caller,
                acts(input.action) || managing,
              )
              if (blocked) return yield* fail(blocked)
              if (input.action === "assign" || input.action === "release") {
                const name =
                  BrowserRuntime.sessions().find((item) => item.id === browserSession)?.name ?? browserSession
                if (input.action === "assign") {
                  const to = input.agent?.trim()
                  if (!to) return yield* fail("assign needs `agent`: the name of the agent that gets the session.")
                  BrowserRuntime.setLease(browserSession, to)
                  const text = `Browser session "${name}" is now assigned to ${to}. Tell ${to} to use the browser tool with session "${browserSession}". Only ${to} (or the operator in Take control) can act in it until you release it.`
                  return { output: { output: text }, content: [{ type: "text" as const, text }] }
                }
                BrowserRuntime.setLease(browserSession, undefined)
                const text = `Browser session "${name}" is free again: any agent may use it.`
                return { output: { output: text }, content: [{ type: "text" as const, text }] }
              }
              // The session the operator selected in the Browser tab (or the only one there is) is the one they put
              // in front of the agent: acting in it needs no per-action question. Another session still asks.
              const here = (yield* ctx.session.get({ sessionID: context.sessionID })).location.directory
              const published = BrowserRuntime.sessions()
              const handedOver =
                BrowserRuntime.selectedSession(here) === browserSession ||
                (BrowserBridge.projectOf(published, here) === undefined &&
                  published.length === 1 &&
                  published[0]!.id === browserSession)
              if (acts(input.action) && !handedOver)
                yield* permission.assert({
                  action: name,
                  resources: [input.url ?? input.selector ?? input.text ?? input.action],
                  save: ["*"],
                  metadata: { action: input.action },
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source: { type: "tool", messageID: context.messageID, id: context.id },
                })
              const result = yield* Effect.tryPromise({
                try: () => perform(browserSession, input),
                catch: (error) =>
                  new ToolFailure({
                    message: `Browser ${input.action} failed: ${error instanceof Error ? error.message : String(error)}`,
                    error,
                  }),
              })
              return {
                output: { output: result.text },
                content: [
                  { type: "text" as const, text: result.text },
                  ...("png" in result && result.png
                    ? [
                        {
                          type: "file" as const,
                          uri: `data:image/png;base64,${result.png}`,
                          mime: "image/png",
                          name: "browser.png",
                        },
                      ]
                    : []),
                ],
              }
            }).pipe(
              Effect.mapError((error) =>
                error instanceof ToolFailure
                  ? error
                  : new ToolFailure({ message: `Browser action failed: ${String(error)}`, error }),
              ),
            ),
        }),
      )
      .pipe(Effect.orDie)
  }),
}
