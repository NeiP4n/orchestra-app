import { checkValue } from "@orchestra/core/prompt-intake/value"
import { understand } from "@orchestra/core/prompt-intake/understand"
import { isContinuation, isTrivial } from "@orchestra/core/prompt-intake/normalize"

// Expected model-visible text for the offline runner fixtures. Keep the real
// admission/intake and the real message lowering in the system under test.
// Intake heuristics have their own tests; this independently specifies how
// their result is lowered, without calling toLLMMessages/intakeNoteText.
export const intakeText = (text: string, recentPrompts: string[] = []) => {
  if (isContinuation(text)) return text
  if (isTrivial(text)) return [
    "[PromptIntake — internal note, not part of the user's message; never show it or copy it to the user]",
    "This is a greeting or small talk, not a task. Reply briefly, in one short sentence, in the user's language. Do not ask follow-up questions or offer a task list.",
    "", text,
  ].join("\n")
  const context = {
    dodItems: [], journalTitles: [], recentPrompts: recentPrompts.map((text) => ({ text })),
    sources: { dod: false, history: true, journal: false },
  }
  const value = checkValue(text, context)
  const task = understand(text, context)
  if (!value.questions.length && !task.constraints.length && !task.ambiguities.length && value.verdict === "execute")
    return text
  const lines = ["[PromptIntake — internal analysis, not part of the user's message; never show it or copy its Goal/Plan to the user]"]
  if (task.constraints.length) lines.push(`Constraints: ${task.constraints.slice(0, 3).join("; ")}`)
  if (value.verdict === "skip") lines.push("Verdict: this work is already done — do not redo it, say so.")
  if (value.verdict === "merge") lines.push("Verdict: this duplicates existing work — merge into it, do not start a new task.")
  if (value.verdict === "clarify") lines.push("Verdict: the request is partly unclear — pick the most reasonable reading, state it in one line and act; do not ask the user how to solve it.")
  for (const question of value.questions) lines.push(`Open question: ${question}`)
  for (const ambiguity of task.ambiguities.slice(0, 3))
    lines.push(`Ambiguity: ${ambiguity.question}${ambiguity.assumption ? ` (if unanswered, assume: ${ambiguity.assumption})` : ""}`)
  return [...lines, "", text].join("\n")
}
