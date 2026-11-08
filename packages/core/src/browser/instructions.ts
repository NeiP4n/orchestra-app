/**
 * What the agent knows about the Browser tab: which browser sessions the project has, which ones run, which one
 * the operator has selected and who controls each. It appears with the first session and updates when they
 * change, so the agent never answers that no browser exists while one is open in the pane.
 */
export * as BrowserInstructions from "./instructions.js"

import { Effect, Schema } from "effect"
import { Instructions } from "../instructions/index.js"
import { BrowserBridge } from "./bridge.js"
import { BrowserRuntime } from "./runtime.js"

const Entry = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  running: Schema.Boolean,
  selected: Schema.Boolean,
  controller: Schema.String,
})
type Entry = typeof Entry.Type

/** Whether the project has any browser session in the Browser tab. */
export function hasSessions(directory: string) {
  try {
    return BrowserBridge.projectOf(BrowserRuntime.sessions(), directory) !== undefined
  } catch {
    return false
  }
}

let lastSeen = ""

export function make(directory: string): Instructions.List {
  return Instructions.make({
    key: Instructions.Key.make("core/browser-sessions"),
    codec: Schema.toCodecJson(Schema.Array(Entry)),
    read: Effect.sync(() => {
      const all = BrowserRuntime.sessions()
      const project = BrowserBridge.projectOf(all, directory)
      const seen = `context for ${directory}: ${all.length} published, project ${project ?? "none"}`
      if (seen !== lastSeen) BrowserRuntime.trace((lastSeen = seen))
      if (project === undefined) return Instructions.removed
      const mine = all.filter((item) => item.project === project)
      if (mine.length === 0) return Instructions.removed
      const held = BrowserRuntime.leases()
      const selected = BrowserRuntime.selectedSession(directory)
      return mine.map(
        (item): Entry => ({
          id: item.id,
          name: item.name,
          running: BrowserRuntime.isOpen(item.id),
          selected: item.id === selected,
          controller: held[item.id]?.agent ?? "none",
        }),
      )
    }).pipe(Effect.orElseSucceed(() => Instructions.removed)),
    render: {
      initial: render,
      changed: (_, current) => render(current),
      removed: () =>
        "The Browser tab has no browser sessions for this project any more. The browser tool's `sessions` action shows the current state.",
    },
  })
}

function render(entries: readonly Entry[]) {
  const running = entries.filter((item) => item.running).length
  return [
    "<browser-sessions>",
    `  The user's Browser tab has ${entries.length} browser session${entries.length === 1 ? "" : "s"} for this project, ${running} running. A session is a real Chrome the user watches in the pane; load the browser tool with the tools loader if it is not loaded yet and use it for the page (screenshot to look, text to read; not desktop_inspect, and never say that no browser exists while one is listed here).`,
    ...entries.map(
      (item) =>
        `  - ${item.name} [${item.id}]${item.selected ? " (selected)" : ""}: ${item.running ? "running" : "not started"}, controller ${item.controller}`,
    ),
    "  You can act in these sessions yourself: the browser tool's open, click and type actions work on them (the operator is asked to allow each action; a session nobody holds needs no assignment). When the operator asks you to click, type or open something in the browser, do it with the tool; do not say you cannot press keys or click, and do not hand the task back to them.",
    "  The browser tool's `sessions` action shows pages and urls; `assign` hands a session to another agent (name it and pass it the session id), `release` frees it. The operator's Take control always wins.",
    "</browser-sessions>",
  ].join("\n")
}
