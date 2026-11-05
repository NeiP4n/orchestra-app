export * as SessionRequestReport from "./request-report.js"

import path from "path"
import { Effect } from "effect"
import type { LLMRequest } from "@orchestra/ai"
import { Global } from "@orchestra/util/global"

// Set ORCHESTRA_REQUEST_REPORT=1 to write a size breakdown of every primary model request to
// <data>/log/requests. It answers "where did the prompt tokens go" without a proxy: system parts,
// each advertised tool and each history message, measured before the provider sees them.
export const enabled = () => Boolean(process.env.ORCHESTRA_REQUEST_REPORT)

// About 3.5 characters per token across prose, JSON schema and code; providers differ by ~15%.
const tokens = (text: string) => Math.ceil(text.length / 3.5)

export const write = (input: { readonly sessionID: string; readonly agent: string; readonly request: LLMRequest }) =>
  Effect.promise(() => {
    const system = input.request.system.map((part, index) => ({
      index,
      tokens: tokens(part.text),
      text: part.text,
    }))
    const tools = input.request.tools
      // Only what providers receive: the output schema stays local.
      .map((tool) => {
        const sent = JSON.stringify({
          name: tool.name,
          description: tool.description,
          input: "inputSchema" in tool ? tool.inputSchema : undefined,
        })
        return { name: tool.name, tokens: tokens(sent), description: tokens(tool.description ?? "") }
      })
      .toSorted((left, right) => right.tokens - left.tokens)
    const messages = input.request.messages.map((message) => ({
      role: message.role,
      tokens: tokens(JSON.stringify(message.content)),
    }))
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
      path.join(Global.Path.log, "requests", `${input.sessionID}-${Date.now()}.json`),
      JSON.stringify(report, null, 2),
    )
  }).pipe(Effect.ignore)
