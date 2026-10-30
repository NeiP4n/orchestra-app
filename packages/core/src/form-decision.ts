export * as FormDecision from "./form-decision.js"

// Who answered a question on the person's behalf, and why. A worker's question normally waits for the person;
// when the project's Orchestrator answers it, the worker's transcript would otherwise show an answer with no
// author and the person could not tell a human choice from an AI one. The answerer notes itself here under the
// question's tool call, and the question tool reads the note when the answer arrives and puts it in the tool's
// metadata for the interface to show. Both run in this process; a note that is never read ages out.
export interface Decision {
  /** Who decided, as the person should read it: the project's name and role. */
  readonly by: string
  /** One short sentence: why this answer. */
  readonly reason?: string
}

const CAPACITY = 200
const notes = new Map<string, Decision>()

export const key = (messageID: string, toolID: string) => `${messageID}:${toolID}`

export const note = (id: string, decision: Decision) => {
  notes.delete(id)
  notes.set(id, decision)
  if (notes.size > CAPACITY) notes.delete(notes.keys().next().value as string)
}

export const take = (id: string) => {
  const decision = notes.get(id)
  notes.delete(id)
  return decision
}
