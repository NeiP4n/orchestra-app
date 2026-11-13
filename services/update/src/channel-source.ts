/** Channel in a development version, preserving the last valid numeric suffix.
 * Scan suffixes once instead of retrying a greedy prefix for every hyphen. */
export function channelSource(value: string) {
  const start = value.startsWith("v0.0.0-") ? 7 : value.startsWith("0.0.0-") ? 6 : -1
  if (start < 0 || /[\r\n\u2028\u2029]/.test(value)) return undefined
  const ends = new Uint32Array(value.length + 1)
  ends[value.length] = value.length
  for (let i = value.length - 1; i >= start; i--) {
    const digit = value.charCodeAt(i) >= 48 && value.charCodeAt(i) <= 57
    ends[i] = digit ? ends[i + 1]! : i
  }
  const terminal = (end: number) => end === value.length || value[end] === "+"
  for (let i = value.length - 1; i > start; i--) {
    if (value[i] !== "-") continue
    const end = ends[i + 1]!
    if (end === i + 1) continue
    if (terminal(end)) return value.slice(start, i)
    if (value[end] !== ".") continue
    const decimal = ends[end + 1]!
    if (decimal > end + 1 && terminal(decimal)) return value.slice(start, i)
  }
  return undefined
}
