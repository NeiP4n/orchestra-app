/** Smaller bounds restrict activity. null is the existing hourly-unlimited option only. */
export function limitExpansion(current: number | null, next: number | null): boolean {
  return (next === null ? Infinity : next) > (current === null ? Infinity : current)
}
export function steppedLimit(current: number | null, direction: -1 | 1, day = false, step = 1): number | null {
  if (current === null) return direction < 0 ? 6 : null
  const max = day ? 100 : 10000
  if (current >= max) return direction > 0 && !day ? null : direction < 0 ? Math.max(1, current - step) : max
  return Math.max(1, Math.min(max, current + direction*step))
}

/** Digits apply immediately only inside the original backend range. Invalid partial input stays visible. */
export function parseSecurityNumber(value:string,max=Number.MAX_SAFE_INTEGER):number|undefined {
 if(!/^\d+$/.test(value))return
 const number=Number(value)
 return Number.isSafeInteger(number)&&number>=1&&number<=max?number:undefined
}
