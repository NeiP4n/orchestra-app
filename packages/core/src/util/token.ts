export * as Token from "./token.js"

const CHARS_PER_TOKEN = 4

export const estimate = (input: string) => Math.max(0, Math.round(input.length / CHARS_PER_TOKEN))
export const estimateChars = (chars: number) => Math.max(0, Math.round(chars / CHARS_PER_TOKEN))

export const WARNING_THRESHOLD = 0.8
export const CRITICAL_THRESHOLD = 0.95

export interface ContextBudget {
  readonly window: number
  readonly used: number
  readonly available: number
  readonly utilization: number
  readonly status: "safe" | "warning" | "critical" | "exceeded"
  readonly warning?: string
}

export function calculateBudget(input: {
  readonly contextLimit: number
  readonly usedTokens: number
  readonly reserveOutput?: number
  readonly warningThreshold?: number
  readonly criticalThreshold?: number
}): ContextBudget {
  const window = Math.max(0, input.contextLimit)
  const used = Math.max(0, input.usedTokens)
  const reserve = Math.max(0, input.reserveOutput ?? 0)
  const effectiveWindow = Math.max(0, window - reserve)
  const available = Math.max(0, effectiveWindow - used)
  const utilization = effectiveWindow > 0 ? Number((used / effectiveWindow).toFixed(4)) : used > 0 ? 1 : 0
  const warningThresh = input.warningThreshold ?? WARNING_THRESHOLD
  const criticalThresh = input.criticalThreshold ?? CRITICAL_THRESHOLD

  let status: ContextBudget["status"] = "safe"
  let warning: string | undefined

  if (used > effectiveWindow) {
    status = "exceeded"
    warning = `Context limit exceeded: used ${used} tokens of ${effectiveWindow} effective window (reserve: ${reserve}).`
  } else if (utilization >= criticalThresh) {
    status = "critical"
    warning = `Context limit critical: ${(utilization * 100).toFixed(1)}% used (${used}/${effectiveWindow} tokens). Compaction recommended.`
  } else if (utilization >= warningThresh) {
    status = "warning"
    warning = `Context limit warning: ${(utilization * 100).toFixed(1)}% used (${used}/${effectiveWindow} tokens).`
  }

  return {
    window,
    used,
    available,
    utilization,
    status,
    warning,
  }
}

export function formatCount(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`
  return String(count)
}

export function estimateBytes(tokens: number): number {
  return Math.max(0, tokens * CHARS_PER_TOKEN)
}


