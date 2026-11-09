/** Smaller bounds restrict activity. null is the existing hourly-unlimited option only. */
export function limitExpansion(current: number | null, next: number | null): boolean {
  return (next === null ? Infinity : next) > (current === null ? Infinity : current)
}
export function steppedLimit(current: number | null, direction: -1 | 1, day = false): number | null {
  if (current === null) return direction < 0 ? 6 : null
  const max = day ? 100 : 10000
  if (current >= max) return direction > 0 && !day ? null : direction < 0 ? current - 1 : max
  return Math.max(1, current + direction)
}
