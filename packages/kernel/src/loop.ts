import type { Message, ToolCall, Transport } from "./transport.js"
import { TransportError } from "./transport.js"

export type Tool = {
  readonly name: string
  run(input: unknown, signal: AbortSignal): Promise<string>
}

export type Event =
  | { type: "text"; delta: string }
  | { type: "call"; call: ToolCall }
  | { type: "result"; id: string; output: string }
  | { type: "wait"; ms: number; reason: string }
  | { type: "done"; messages: ReadonlyArray<Message> }

export type Options = {
  transport: Transport
  tools: ReadonlyArray<Tool>
  messages: ReadonlyArray<Message>
  system?: string
  signal?: AbortSignal
  // Shrinks history after a context-overflow; without it the overflow is fatal.
  compact?: (messages: ReadonlyArray<Message>) => Promise<ReadonlyArray<Message>>
  sleep?: (ms: number) => Promise<void>
}

/**
 * The agent loop. It has no step ceiling: it ends when the model stops calling tools, the signal
 * aborts, or a failure is fatal. Rate limits wait and retry, overflow compacts and retries, and
 * tool calls from one answer run in parallel.
 */
export async function* run(options: Options): AsyncGenerator<Event> {
  const signal = options.signal ?? new AbortController().signal
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const tools = new Map(options.tools.map((tool) => [tool.name, tool]))
  const history = { value: options.messages }

  while (!signal.aborted) {
    const answer = { text: "", calls: [] as Array<ToolCall> }
    try {
      for await (const chunk of options.transport.send({ messages: history.value, system: options.system }, signal)) {
        if (chunk.type === "text") {
          answer.text += chunk.delta
          yield chunk
          continue
        }
        answer.calls.push(chunk.call)
        yield chunk
      }
    } catch (error) {
      if (!(error instanceof TransportError)) throw error
      if (error.kind === "context-overflow" && options.compact) {
        history.value = await options.compact(history.value)
        continue
      }
      if (error.kind === "fatal" || error.kind === "context-overflow") throw error
      const ms = error.retryAfter ?? 1_000
      yield { type: "wait", ms, reason: error.message }
      await sleep(ms)
      continue
    }

    history.value = [...history.value, { role: "assistant", text: answer.text, calls: answer.calls }]
    if (answer.calls.length === 0) break

    const results = await Promise.all(
      answer.calls.map(async (call) => ({
        id: call.id,
        output: await execute(tools.get(call.name), call, signal),
      })),
    )
    for (const result of results) yield { type: "result", ...result }
    history.value = [...history.value, ...results.map((result) => ({ role: "tool" as const, ...result }))]
  }

  yield { type: "done", messages: history.value }
}

// A failing tool is information for the model, not a reason to stop the session.
async function execute(tool: Tool | undefined, call: ToolCall, signal: AbortSignal) {
  if (!tool) return `error: unknown tool ${call.name}`
  return tool.run(call.input, signal).catch((error: unknown) => `error: ${error instanceof Error ? error.message : String(error)}`)
}
