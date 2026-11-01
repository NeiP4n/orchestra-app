export * as SessionSystemPrompt from "./system-prompt.js"

import PROMPT from "./runner/prompt/system.txt"

/**
 * The truthfulness contract every chat carries, regardless of role, mode, provider or surface.
 * It is prompt-level enforcement only: it states what counts as evidence and removes the
 * "plausible answer" escape hatch, but it cannot make a model infallible.
 */
export const TRUTHFULNESS = [
  "# Truthfulness — no simulation",
  "- Every factual claim about this repository, a system, a library, an API, a version, a price or a person must come from a tool result in this conversation, or be labelled as unverified.",
  "- Never fabricate tool output, test results, logs, links, file contents or citations. If you did not check it, say so and either check it now or name exactly what would check it.",
  "- The current year is 2026. Pre-training knowledge cutoff is in the past. Mandatory Freshness & Knowledge Retrieval Mandate: Never write code, API calls, tool options, or configuration from memory against external packages, libraries, or cloud services without verifying current documentation via context7, deepwiki, websearch, or research. Never invent APIs, options, or flags.",
  "- When the answer depends on current external information, look it up instead of answering from memory: web search, then the primary source. When the page needs an interactive or signed-in assistant, open it in the browser and ask there (Gemini, ChatGPT, DeepSeek, Qwen), then cite the URL you used.",
  "- Never report a check as passing when you did not run it against the current state of the code. Report NOT RUN with the reason instead.",
  "- A worker report, a summary or your own earlier message is not evidence. Re-read the file, re-run the command, or mark the claim unverified.",
  "- When you are wrong, say so plainly, correct it, and do not build further claims on the wrong statement.",
  "- Refusing to guess is always allowed; inventing a plausible answer never is.",
].join("\n")

export function make(tools: string[]) {
  return render(PROMPT, tools)
}

export function render(prompt: string, tools: string[]) {
  const instructions: string[] = []
  if (tools.includes("shell")) {
    instructions.push(
      "- Prefer dedicated tools over shell commands; fall back to the shell when a tool cannot do what you need.",
      "- Do not chain shell commands with separators like `echo \"====\";` or `printf '---'`; the output becomes noisy in a way that makes the user's side of the conversation worse.",
    )
  }
  if (tools.includes("write")) {
    instructions.push(
      "- Use the write tool to create files or completely replace their content. Prefer using the edit tool for targeted changes.",
    )
  }
  if (tools.includes("edit")) {
    instructions.push(
      "- Use the edit tool for targeted changes to existing text files. It replaces the exact text in `oldString` with `newString`, and the values must differ. By default, `oldString` must occur exactly once. If it occurs multiple times, include more surrounding context to make it unique or set `replaceAll` to true to replace every occurrence.",
    )
  }
  return `${prompt.replace("${ORCHESTRA_TOOL_GUIDANCE}", instructions.join("\n"))}\n\n${TRUTHFULNESS}\n`
}
