/** Distinct chat IDs may share a title. Disambiguate display labels without renaming chats. */
export function networkNames(items: readonly { id: string; title: string }[], limit = 18): Record<string, string> {
  const hash = (id: string) => {
    let value = 2166136261
    for (const char of id) value = Math.imul(value ^ char.charCodeAt(0), 16777619)
    return (value >>> 0).toString(36).slice(-4).padStart(4, "0")
  }
  const clean = (value: string) => value.replace(/[\x00-\x1f\x7f]/g, "").replace(/\s+/g, " ").trim()
  const titles = items.map((item) => clean(item.title))
  return Object.fromEntries(items.map((item, index) => {
    const title = titles[index]!
    const duplicate = titles.filter((other) => other.slice(0, limit) === title.slice(0, limit)).length > 1
    const suffix = duplicate ? ` #${hash(item.id)}` : ""
    const room = Math.max(1, limit - suffix.length)
    return [item.id, (title.length <= room ? title : `${title.slice(0, room - 1)}…`) + suffix]
  }))
}
export interface LabelRect { x: number; y: number; width: number }
/** Reject overlapping text rather than paint a second label into the first one's suffix. */
export function claimNetworkLabel(occupied: LabelRect[], rect: LabelRect): boolean {
  if (occupied.some((other) => other.y === rect.y && rect.x < other.x + other.width + 1 && other.x < rect.x + rect.width + 1)) return false
  occupied.push(rect)
  return true
}
