export * as SessionRequestReport from "./request-report.js"

import path from "path"
import { readdir, stat, unlink } from "node:fs/promises"
import { Effect } from "effect"
import type { LLMRequest } from "@orchestra/ai"
import { Global } from "@orchestra/util/global"

// Set ORCHESTRA_REQUEST_REPORT=1 to write a size breakdown of every primary model request to
// <data>/log/requests. It answers "where did the prompt tokens go" without a proxy: system parts,
// each advertised tool and each history message, measured before the provider sees them.
//
// The full prompt and messages land on disk, so two things are non-negotiable:
//   - no secrets: anything that looks like a key, token or password is redacted before the
//     write, because a prompt can carry credentials (a pasted .env, an Authorization header,
//     a tool description with an example key);
//   - a retention window: reports older than ORCHESTRA_REQUEST_REPORT_RETENTION_DAYS
//     (default 7) are pruned on every write, so the log cannot grow forever or keep a
//     leaked secret around for months.
export const enabled = () => Boolean(process.env.ORCHESTRA_REQUEST_REPORT)

export const DEFAULT_RETENTION_DAYS = 7

export const retentionDays = () => {
  const parsed = Number.parseInt(process.env.ORCHESTRA_REQUEST_REPORT_RETENTION_DAYS ?? "", 10)
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : DEFAULT_RETENTION_DAYS
}

import { redactSecrets } from "./secret-redaction.js"
export { redactSecrets } from "./secret-redaction.js"

// About 3.5 characters per token across prose, JSON schema and code; providers differ by ~15%.
const tokens = (text: string) => Math.ceil(text.length / 3.5)

/** Delete report files older than the retention window. Best-effort: a stuck file never breaks a write. */
export const pruneOldReports = async (directory: string, now = Date.now()) => {
  const cutoff = now - retentionDays() * 24 * 60 * 60 * 1000
  let entries: string[]
  try {
    entries = await readdir(directory)
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue
    const file = path.join(directory, entry)
    try {
      if ((await stat(file)).mtimeMs < cutoff) await unlink(file)
    } catch {
      // A file that cannot be read or removed stays; the next write retries it.
    }
  }
}

export const write = (
  input: { readonly sessionID: string; readonly agent: string; readonly request: LLMRequest },
  directory = path.join(Global.Path.log, "requests"),
) =>
  Effect.promise(async () => {
    await pruneOldReports(directory)
    const system = input.request.system.map((part, index) => {
      const text = redactSecrets(part.text)
      return { index, tokens: tokens(text), text }
    })
    const tools = input.request.tools
      // Only what providers receive: the output schema stays local.
      .map((tool) => {
        const sent = redactSecrets(
          JSON.stringify({
            name: tool.name,
            description: tool.description,
            input: "inputSchema" in tool ? tool.inputSchema : undefined,
          }),
        )
        return { name: tool.name, tokens: tokens(sent), description: tokens(redactSecrets(tool.description ?? "")) }
      })
      .toSorted((left, right) => right.tokens - left.tokens)
    const messages = input.request.messages.map((message) => {
      const text = redactSecrets(JSON.stringify(message.content))
      return { role: message.role, tokens: tokens(text) }
    })
    const sum = (items: ReadonlyArray<{ tokens: number }>) => items.reduce((total, item) => total + item.tokens, 0)
    const report = {
      sessionID: input.sessionID,
      agent: input.agent,
      model: `${input.request.model.provider}/${input.request.model.id}`,
      totals: {
        all: sum(system) + sum(tools) + sum(messages),
        system: sum(system),
        tools: sum(tools),
        toolCount: tools.length,
        messages: sum(messages),
      },
      system,
      tools,
      messages,
    }
    return Bun.write(
      path.join(directory, `${input.sessionID}-${Date.now()}.json`),
      JSON.stringify(report, null, 2),
    )
  }).pipe(Effect.ignore)
