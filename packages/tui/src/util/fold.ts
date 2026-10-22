import { stringWidth } from "./string-width"

// Long text in the chat is shown folded: the first rows stay, the rest opens on a click. A wall of
// text is not information; the first lines usually are.

function rowsOf(line: string, width: number) {
  return Math.max(1, Math.ceil(stringWidth(line) / Math.max(1, width)))
}

export type Folded = { readonly head: string; readonly hidden: number }

// The first `maxRows` rows of `text` as they wrap at `width`, and how many rows were left out.
export function foldRows(text: string, width: number, maxRows: number): Folded {
  const lines = text.split("\n")
  const total = lines.reduce((sum, line) => sum + rowsOf(line, width), 0)
  if (total <= maxRows) return { head: text, hidden: 0 }
  const head: string[] = []
  let used = 0
  for (const line of lines) {
    const rows = rowsOf(line, width)
    if (used + rows <= maxRows) {
      head.push(line)
      used += rows
      continue
    }
    const room = maxRows - used
    if (room > 0) head.push(line.slice(0, room * Math.max(1, width)).trimEnd() + "…")
    used = maxRows
    break
  }
  return { head: head.join("\n"), hidden: total - maxRows }
}

// The one line an error is known by: its first sentence, kept short.
export function errorHeadline(text: string, limit = 100) {
  const flat = text.trim().replace(/\s+/g, " ")
  const stop = flat.search(/[.!?](\s|$)/)
  const sentence = stop >= 0 ? flat.slice(0, stop + 1) : flat
  if (sentence.length <= limit) return sentence
  // Cut at a word, not in the middle of one, unless the only space is very early.
  const cut = sentence.slice(0, limit - 1)
  const space = cut.lastIndexOf(" ")
  return (space > limit * 0.6 ? cut.slice(0, space) : cut).trimEnd() + "…"
}

// Whether an error is long enough to fold.
export function errorIsLong(text: string, width: number) {
  return text.trim().split("\n").reduce((sum, line) => sum + rowsOf(line, width), 0) > 2
}
