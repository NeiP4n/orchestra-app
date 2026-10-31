export * as InstructionThinking from "./thinking.js"

import { Effect, Schema } from "effect"
import { Instructions } from "./index.js"

export interface Options {
  /**
   * The project ships `script/check.ts` and `script/map.ts`, so the budget rule may name them.
   * Without them the rule stays generic: telling a session to run a script that does not exist
   * costs a failed call and teaches it to guess.
   */
  readonly scripts?: boolean
}

// Four reasoning habits for work that is ambiguous, risky or expensive. They stay deliberately
// short: this text is part of every request, so one wasted line costs more than it teaches.
export function thinkingSource(options: Options = {}): Instructions.List {
  const text = render(options)
  return Instructions.make({
    key: Instructions.Key.make("core/thinking"),
    codec: Schema.toCodecJson(Schema.String),
    read: Effect.succeed(text),
    render: {
      initial: (value) => value,
      changed: (_previous, value) => value,
    },
  })
}

function render(options: Options) {
  return [
    "<thinking>",
    "  Four habits for a hard task. They change nothing about a one-line fix; use them when the choice is ambiguous, the change is risky or the work is expensive.",
    "  Tree-of-Thoughts — when two or three designs could all be right, name them, say what evidence settles the choice (a file, a test, a measurement), and check the cheapest branch first. Keep a losing branch to one sentence, not to code, and drop it as soon as a fact kills it instead of defending it.",
    "  Inversion (premortem) — before editing, ask what would make this change break later: a migration that cannot be rolled back, a Windows path, encoding or path-length difference, a missing permission, an old client that still sends the old shape, a retry that runs twice. Name the failure first, then make the change that survives it; a risk you cannot remove cheaply is reported, not hidden.",
    '  Devil\'s Advocate — for every conclusion the code seems to support, look for the case that falsifies it: empty list, one element, duplicate id, a failure mid-stream, two writers, a user who cancels. Accept a design only after you tried to break it, and say what could still break it.',
    "  Budget-Aware — reason where a mistake is expensive and prefer a tool call to guessing. Never repeat a search or a read that answered nothing: after two failures change the query, the path or the approach. Locate a symbol before reading a large file, and prove a change with the narrowest real check instead of the whole suite.",
    ...(options.scripts
      ? [
          "  This project ships `bun script/check.ts` (type-checks only the packages you touched, `--all` for every active package) and `bun script/map.ts <file>` (a one-screen map of a file's declarations, `--body 120-150` for a range). Use them instead of one typecheck per package or reading a big file in slices.",
        ]
      : []),
    "</thinking>",
  ].join("\n")
}
