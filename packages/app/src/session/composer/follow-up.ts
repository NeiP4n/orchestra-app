import type { SessionMessageInfo } from "@orchestra/client/promise"

/**
 * One-click follow-up actions offered under the composer once an assistant
 * answer is complete. The actions are derived from the answer itself so the
 * bar stays relevant without another model call: long answers can be
 * summarized, answers with code can be explained, and every answer can be
 * continued, detailed, planned from, or checked for risks.
 */
export type FollowUpActionID = "continue" | "summarize" | "details" | "plan" | "risks" | "explainCode"

export type FollowUpAnswer = { messageID: string; text: string }

/** Answers at least this long get a summarize action first. */
export const FOLLOW_UP_SUMMARIZE_MIN_LENGTH = 1200

/**
 * The answer the follow-up bar acts on: the newest completed assistant
 * message, but only while it is still the tail of the conversation. A user
 * message after it means the user already replied on their own, and an
 * errored or unfinished message has nothing worth following up on.
 */
export function lastFollowUpAnswer(messages: readonly SessionMessageInfo[]): FollowUpAnswer | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]

    if (message.type === "user") return undefined
    if (message.type !== "assistant") continue
    if (message.time.completed === undefined || message.error) return undefined

    const text = message.content
      .filter((content) => content.type === "text")
      .map((content) => content.text)
      .join("\n\n")
      .trim()

    if (!text) return undefined

    return { messageID: message.id, text }
  }

  return undefined
}

export function followUpActions(text: string): FollowUpActionID[] {
  const actions: FollowUpActionID[] = []

  if (text.length >= FOLLOW_UP_SUMMARIZE_MIN_LENGTH) actions.push("summarize")
  actions.push("continue", "details")
  if (text.includes("```")) actions.push("explainCode")
  actions.push("plan", "risks")

  return actions
}

export function followUpVisible(input: {
  answer: FollowUpAnswer | undefined
  working: boolean
  blocked: boolean
  child: boolean
  dismissedMessageID: string | undefined
}): boolean {
  if (!input.answer || input.working || input.blocked || input.child) return false

  return input.dismissedMessageID !== input.answer.messageID
}
