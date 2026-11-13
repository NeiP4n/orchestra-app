export * as SessionDeliveryState from "./delivery-state.js"
import type { SessionMessage } from "./message.js"

export const key = (sessionID: string) => `session/delivered/${sessionID}`
export interface Receipt { readonly user: string; readonly final: string; readonly tail: string }
// Exact durable history boundary, not a textual DONE guess. A new user, worker
// result or control message invalidates the receipt and is allowed to run.
export function receipt(messages: ReadonlyArray<SessionMessage.Info>): Receipt | undefined {
  const user = messages.findLast(message => message.type === "user")
  const final = messages.findLast(message => message.type === "assistant")
  const tail = messages.at(-1)
  if (!user || !final || final.type !== "assistant" || final.error || final.finish !== "stop" || !tail) return
  if (!final.content.some(part => part.type === "text" && part.text.trim())) return
  return {user: user.id, final: final.id, tail: tail.id}
}
export function matches(value: unknown, messages: ReadonlyArray<SessionMessage.Info>): boolean {
  const current = receipt(messages)
  return !!current && !!value && typeof value === "object" &&
    "user" in value && value.user === current.user && "final" in value && value.final === current.final &&
    "tail" in value && value.tail === current.tail
}
