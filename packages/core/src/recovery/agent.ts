export * as RecoveryAgent from "./agent.js"

import {
  LLM,
  Message,
  Tool,
  ToolResultPart,
  ToolRuntime,
  type LanguageModel,
} from "@orchestra/ai"
import type { Model } from "@orchestra/schema/model"
import type { Recovery } from "@orchestra/schema/recovery"
import { Effect } from "effect"
import { recoveryTools } from "./tools.js"

/** Max model rounds per chat message: enough to diagnose, fix and verify, bounded so a loop cannot burn tokens forever. */
export const MAX_STEPS = 12
const MAX_STEP_OUTPUT_CHARS = 2_000

const SYSTEM_PROMPT = `Ты — агент восстановления Orchestra. Пользователь открыл запасной mini-chat, потому что сама Orchestra сломана и нормально в неё войти нельзя.

Твоя задача — починить саму Orchestra: её код, конфиг и запуск. Работай АВТОНОМНО: никогда не спрашивай у пользователя разрешения и не задавай вопросов — решай сам.

Как работать:
- Сначала разберись, что сломалось: прочитай файлы, конфиг, логи, запусти тесты или сборку и посмотри на ошибку.
- Потом чини: правь код и конфиг, запускай тесты и сборку, проверяй, что ошибка ушла.
- Проверяй себя тестами и запуском, а не словами. Если тест красный — чини дальше.
- Работай только внутри репозитория Orchestra. Не трогай ничего за его пределами и не удаляй данные пользователя.
- Если для починки нужен перезапуск сервера — так и скажи в конце.

Когда закончишь, заверши ответ строкой вида:
Исправлено: <что именно починено, одним предложением>
Если починить не удалось — строкой вида:
Не исправлено: <почему, одним предложением>

Отвечай на русском.`

const NOT_FIXED_PREFIXES = ["не исправлено:", "not fixed:"]

/**
 * The agent's `Исправлено:` line, when it wrote one — fail-closed. Any
 * `Не исправлено:` / `Not fixed:` anywhere in the reply means NOT fixed,
 * even when a positive marker appears too: "Не исправлено:" contains the
 * positive substring, so a substring search reads it as fixed. The
 * positive marker counts only at the start of a line or right after a
 * sentence boundary ("Готово. Исправлено: …"), never mid-sentence — a
 * quote or an error dump mentioning the phrase is not a verdict. The last
 * such marker wins, and its text up to the end of the line is the summary.
 */
export function parseFixed(reply: string): string | undefined {
  const lower = reply.toLowerCase()
  if (NOT_FIXED_PREFIXES.some((prefix) => lower.includes(prefix))) return undefined
  const pattern = /(?:^|[.!?]\s+)(исправлено:|fixed:)\s*([^\n]*)/gim
  let last: string | undefined
  let match = pattern.exec(reply)
  while (match !== null) {
    const text = match[2]?.trim()
    if (text) last = text
    match = pattern.exec(reply)
  }
  return last
}

/**
 * Whether the tool itself reports success. The dispatch result type only
 * says whether the call errored at the transport level; our tools report
 * refusals and file errors as a normal `{ success: false, ... }` value, so
 * that field is the authority.
 */
function toolSuccess(result: { type: string; value: unknown }): boolean {
  if (result.type === "error") return false
  if (
    result.type === "json" &&
    typeof result.value === "object" &&
    result.value !== null &&
    "success" in result.value
  )
    return (result.value as { success: unknown }).success === true
  return true
}

function toolResultText(result: { type: string; value: unknown }): string {
  switch (result.type) {
    case "text":
      return typeof result.value === "string" ? result.value : JSON.stringify(result.value)
    case "json":
      return JSON.stringify(result.value)
    case "error":
      return `Ошибка: ${typeof result.value === "string" ? result.value : JSON.stringify(result.value)}`
    case "content":
      return (Array.isArray(result.value) ? result.value : [])
        .map((item) => (typeof item === "object" && item !== null && "type" in item && item.type === "text" && "text" in item ? String(item.text) : JSON.stringify(item)))
        .join("\n")
    default:
      return JSON.stringify(result.value)
  }
}

/**
 * One repair round: send the conversation to the model, run the tools it
 * calls, feed the results back, repeat until it answers with text or the
 * step budget runs out. Only the model call needs a provider; the tools are
 * local (files + shell inside the repo).
 */
export const runRepairLoop = Effect.fn("RecoveryAgent.runRepairLoop")(function* (input: {
  model: LanguageModel
  /** Catalog identity of the model (durable records use this, never the API model id). */
  ref: Model.Ref
  messages: readonly Recovery.RecoveryChatMessage[]
  root: string
  maxSteps?: number
}) {
  const maxSteps = input.maxSteps ?? MAX_STEPS
  const tools = recoveryTools(input.root)
  const definitions = Tool.toDefinitions(tools)
  let messages: ReadonlyArray<Message> = input.messages.map((message) =>
    message.role === "user" ? Message.user(message.content) : Message.assistant(message.content),
  )
  const steps: Array<Recovery.RecoveryStep> = []
  let inputTokens = 0
  let outputTokens = 0
  let lastText = ""

  for (let step = 0; step < maxSteps; step++) {
    const response = yield* LLM.generate({
      model: input.model,
      system: SYSTEM_PROMPT,
      messages,
      tools: definitions,
    })
    if (response.usage?.inputTokens) inputTokens += response.usage.inputTokens
    if (response.usage?.outputTokens) outputTokens += response.usage.outputTokens
    lastText = response.text
    const calls = response.toolCalls.filter((call) => !call.providerExecuted)
    if (calls.length === 0) {
      return {
        reply: response.text,
        steps,
        root: input.root,
        ...(parseFixed(response.text) ? { fixed: parseFixed(response.text) } : {}),
        ...(inputTokens ? { inputTokens } : {}),
        ...(outputTokens ? { outputTokens } : {}),
        model: input.ref,
      }
    }
    messages = [...messages, response.message]
    for (const call of calls) {
      const settled = yield* ToolRuntime.dispatch(tools, call)
      const output = toolResultText(settled.result)
      steps.push({
        tool: call.name,
        input: call.input,
        output: output.length <= MAX_STEP_OUTPUT_CHARS ? output : `${output.slice(0, MAX_STEP_OUTPUT_CHARS)}\n[... truncated ...]`,
        success: toolSuccess(settled.result),
      })
      messages = [
        ...messages,
        Message.tool(ToolResultPart.make({ id: call.id, name: call.name, result: settled.result })),
      ]
    }
  }

  return {
    reply: `${lastText}\n\n(Достигнут лимит шагов (${maxSteps}) — починка не завершена. Опишите, что осталось, и я продолжу.)`,
    steps,
    root: input.root,
    ...(inputTokens ? { inputTokens } : {}),
    ...(outputTokens ? { outputTokens } : {}),
    model: input.ref,
  }
})
