export * as ToolRouter from "./router.js"

import type { Message } from "@orchestra/ai"
import type { Tool } from "@orchestra/schema/tool"
import { Effect, Schema } from "effect"

// Direct tools split into core (always advertised) and on-demand. An on-demand tool costs one
// index line until the session needs it; then its full schema joins every later request. Which
// tools a session has loaded is read back from its own history (a `tools` call or a call of the
// tool itself), so the choice is as durable as the conversation and survives restarts without
// separate state, and installing or removing a plugin changes the index on the next request.
export const name = "tools"

// ORCHESTRA_TOOL_ROUTER=off advertises every direct tool, as before on-demand loading existed.
export const enabled = () => process.env.ORCHESTRA_TOOL_ROUTER !== "off"

export const isCore = (tool: Tool.Info) => tool.options?.core === true

const SUMMARY_LIMIT = 110
// Tools sharing a name prefix (desktop, desktop_click, desktop_type...) share one index line and load together.
const GROUP_MIN = 3

export const Input = Schema.Struct({
  load: Schema.Array(Schema.String).annotate({ description: "Names from the tools index to load." }),
})

export function create(lazy: ReadonlyMap<string, Tool.Info>): Tool.Info<typeof Input> {
  const index = groups(lazy)
  return {
    name,
    description: [
      "Load more tools. The tools below exist but their schemas are not in this request; load the ones the task needs and they are callable from your next step on. Unloaded tools cost nothing, so load only what you will call.",
      "",
      ...Array.from(index, ([key, members]) => {
        const rest = members.filter((member) => member !== key).map((member) => member.slice(key.length + 1))
        const label = members.length === 1 ? key : `${key} (${members.length} tools: ${rest.join(", ")})`
        return `- ${label}: ${summary(head(lazy, key, members).description)}`
      }),
    ].join("\n"),
    input: Input,
    options: { codemode: false, core: true },
    execute: (input) =>
      Effect.succeed({
        content: [
          ...(input.load.some((item) => index.has(item) || lazy.has(item))
            ? [`Loaded: ${input.load.flatMap((item) => expand(index, lazy, item)).join(", ")}. Call them directly from your next step.`]
            : []),
          ...input.load
            .filter((item) => !index.has(item) && !lazy.has(item))
            .map((item) => `Not in the tools index: ${item}.`),
        ].join("\n"),
      }),
  }
}

/** On-demand tool names this request advertises: loaded or called earlier, or triggered by the user's words. */
export function selected(messages: ReadonlyArray<Message>, lazy: ReadonlyMap<string, Tool.Info>) {
  const result = new Set<string>()
  const index = groups(lazy)
  const triggers = Array.from(index, ([key, members]) => [members, patterns(key, head(lazy, key, members))] as const)
  const add = (items: ReadonlyArray<string>) => items.forEach((item) => result.add(item))
  for (const message of messages) {
    for (const part of message.content) {
      if (part.type === "tool-call") {
        if (lazy.has(part.name)) result.add(part.name)
        if (part.name === name) loadedBy(part.input).forEach((item) => add(expand(index, lazy, item)))
      }
      // Harness-written user messages (shell results, reports, reminders) open with a tag; only
      // the person's own words trigger tools, or a word in some command output would load them.
      if (part.type === "text" && message.role === "user" && !part.text.trimStart().startsWith("<"))
        triggers.forEach(([members, list]) => list.some((pattern) => pattern.test(part.text)) && add(members))
    }
  }
  return result
}

// Index keys to the tools they load: a shared prefix with enough members, otherwise the tool itself.
function groups(lazy: ReadonlyMap<string, Tool.Info>) {
  const prefix = (key: string) => key.split("_", 1)[0] ?? key
  const counts = Map.groupBy(lazy.keys(), prefix)
  const result = new Map<string, Array<string>>()
  for (const key of lazy.keys()) {
    const target = (counts.get(prefix(key))?.length ?? 0) >= GROUP_MIN ? prefix(key) : key
    result.set(target, [...(result.get(target) ?? []), key])
  }
  return result
}

function expand(index: ReadonlyMap<string, ReadonlyArray<string>>, lazy: ReadonlyMap<string, Tool.Info>, item: string) {
  return index.get(item) ?? (lazy.has(item) ? [item] : [])
}

// The group's own tool describes it when one is named like the prefix (desktop for desktop_*).
function head(lazy: ReadonlyMap<string, Tool.Info>, key: string, members: ReadonlyArray<string>) {
  return lazy.get(key) ?? lazy.get(members[0] ?? key)!
}

function loadedBy(input: unknown) {
  const decoded = Schema.decodeUnknownOption(Input)(input)
  return decoded._tag === "Some" ? decoded.value.load : []
}

function patterns(key: string, tool: Tool.Info) {
  const own = new RegExp(`(^|[^\\w-])${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\w-])`, "i")
  return [
    own,
    ...(tool.options?.triggers ?? []).flatMap((source) => {
      try {
        return [new RegExp(source, "iu")]
      } catch {
        return []
      }
    }),
  ]
}

function summary(description: string) {
  const first = description.split(/\n|(?<=\.)\s/, 1)[0]?.trim() ?? ""
  return first.length > SUMMARY_LIMIT ? `${first.slice(0, SUMMARY_LIMIT - 3)}...` : first
}
