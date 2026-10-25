import type { LLM, ToolDefinition } from "@orchestra/ai"

export type CompatibilityInput = {
  readonly providerID: string
  readonly tools?: ReadonlyArray<ToolDefinition>
  readonly toolChoice?: LLM.RequestInput["toolChoice"]
  readonly stateless?: boolean
}

export type CompatibilityOutput = {
  readonly tools: ReadonlyArray<ToolDefinition>
  readonly toolChoice: LLM.RequestInput["toolChoice"] | undefined
}

export const zenRequiredToolNames: readonly string[] = []

/** Provider transport compatibility only; it never grants tool execution permission. */
export function prepare(input: CompatibilityInput): CompatibilityOutput {
  return {
    tools: input.tools ?? [],
    toolChoice: input.toolChoice,
  }
}
