export * as Jailbreak from "./jailbreak.js"

import { prompts } from "./jailbreak/catalog.js"
import type { Prompt } from "./jailbreak/catalog.js"

export { commit, source } from "./jailbreak/catalog.js"
export type { Prompt } from "./jailbreak/catalog.js"

export const defaultID = "unified"

/** The requested prompt, or the default one when the id is missing or unknown. */
export function find(id: string | undefined): Prompt | undefined {
  return prompts.find((prompt) => prompt.id === (id || defaultID)) ?? prompts.find((prompt) => prompt.id === defaultID)
}

/**
 * The bundled prompt that fits a model, so nobody has to name one: the longest prompt id that the
 * model id starts with, after folding `v4` to `4`, `4.1` to `4-1` and dropping the provider prefix.
 * `deepseek-v4.1-flash-1017` therefore picks `deepseek-4-1`. Falls back to the default prompt.
 */
export function match(modelID: string | undefined): Prompt | undefined {
  const model = normalize(modelID ?? "")
  const best = prompts
    .filter((prompt) => prompt.id !== defaultID && prompt.id !== "beam")
    .map((prompt) => ({ prompt, key: normalize(prompt.id) }))
    .filter((entry) => entry.key.length > 3 && model.startsWith(entry.key))
    .sort((left, right) => right.key.length - left.key.length)[0]
  return best?.prompt ?? find(defaultID)
}

const normalize = (id: string) =>
  id
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-v(?=\d)/g, "-")
    .replace(/^-|-$/g, "")
