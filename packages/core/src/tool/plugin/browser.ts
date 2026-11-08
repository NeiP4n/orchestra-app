export * as BrowserTool from "./browser.js"

import { ToolFailure } from "@orchestra/ai"
import type { Context } from "@orchestra/plugin/effect/plugin"
import { optional } from "@orchestra/schema/schema"
import { Effect, Schema } from "effect"
import { BrowserPage } from "../../browser/page.js"
import { BrowserRuntime } from "../../browser/runtime.js"
import { Cdp } from "../../browser/cdp.js"
import { Chrome } from "../../browser/chrome.js"
import { Permission } from "../../permission.js"

export const name = "browser"

// The first sentence is the line in the on-demand tools index, so it says when to reach for this tool.
export const description = [
  "See and drive the page in the user's Browser tab (use this, not desktop_inspect, to see what they see in it).",
  "It is the browser session the operator has selected for this project in the Browser tab: the same Chrome the operator sees there, on its own profile, so logins made in it are real and your clicks act with those accounts. You never launch a browser of your own: this one starts if it is not running.",
  "",
  "Actions:",
  "  open — go to an http or https address (url), then return the page title, address and text.",
  "  text — the visible text of the current page.",
  "  info — the current address and title only.",
  "  screenshot — a picture of the page (shown as an image when the model supports images, with the address and title as text otherwise).",
  "  click — click the element matching a CSS selector, or the clickable element whose text contains `text`.",
  "  type — put `text` into the field matching `selector`; submit: true presses Enter afterwards.",
  "",
  "Read the page text first and pick targets from it. open, click and type ask the operator for permission. Stop and tell the operator before entering payment details, passwords, or anything that publishes or spends.",
].join("\n")

/** Words that load this tool: the browser itself, and the ways a person asks whether you can see their page. */
export const triggers = [
  "браузер|browser|сайт|страниц[уаы]|web ?page|website",
  "ты видишь|видишь (это|меня|страницу|экран)|что (я )?(вижу|открыт)|что на (экране|странице|сайте)|посмотри|открой (сайт|страниц|ссылк)|can you see|do you see|what('s| is) on (my|the) (screen|page)|look at (my|the) (page|browser|tab)",
]

export const Input = Schema.Struct({
  action: Schema.Literals(["open", "text", "info", "screenshot", "click", "type"]),
  url: optional(Schema.String.annotate({ description: "http or https address, for open" })),
  selector: optional(Schema.String.annotate({ description: "CSS selector, for click and type" })),
  text: optional(Schema.String.annotate({ description: "Text to type, or text of the element to click" })),
  submit: optional(Schema.Boolean.annotate({ description: "Press Enter after typing" })),
})
export type Input = typeof Input.Type

export const Output = Schema.Struct({ output: Schema.String })
export type Output = typeof Output.Type

/** Actions that change the page or act with the operator's logged-in accounts ask first. */
export const acts = (action: Input["action"]) => action === "open" || action === "click" || action === "type"

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

export async function perform(sessionID: string, input: Input) {
  const client = await BrowserRuntime.open(sessionID)
  switch (input.action) {
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
      await settle()
      return {
        text: `Clicked ${result.tag}${result.text ? ` "${result.text}"` : ""}.\n\n${page(await Cdp.pageInfo(client), await Cdp.pageText(client))}`,
      }
    }
    case "type": {
      if (!input.selector || input.text === undefined) throw new Error("type needs a selector and a text.")
      const result = await evaluate(client, BrowserPage.typeExpression({ selector: input.selector, text: input.text }))
      if (!result.ok) throw new Error(result.error ?? "Typing failed.")
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

    // The project's selected browser session, found from the directory this chat works in.
    const sessionFor = Effect.fn("BrowserTool.sessionFor")(function* (
      sessionID: Parameters<typeof ctx.session.get>[0]["sessionID"],
    ) {
      const session = yield* ctx.session.get({ sessionID })
      const chosen = BrowserRuntime.selectedSession(session.location.directory)
      return chosen === undefined ? yield* Effect.fail(new ToolFailure({ message: NO_SESSION })) : chosen
    })

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
              const browserSession = yield* sessionFor(context.sessionID)
              if (acts(input.action))
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
