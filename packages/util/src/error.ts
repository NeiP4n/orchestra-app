// One readable line for anything a caller caught. Every package used to carry its own copy of this
// with slightly different answers for an Effect failure or a plain object; this is the shape they
// agree on: a string, an Error, an object carrying a message (Effect failures keep theirs in
// `message` or in `data.message`), and a last-resort text for everything else.
export function errorMessage(error: unknown): string {
  if (typeof error === "string") return error
  if (typeof error === "function") return error.name || "unknown error"
  if (error instanceof Error) return error.message || error.name || "unknown error"
  if (typeof error === "object" && error !== null) {
    if ("message" in error && typeof error.message === "string" && error.message) return error.message
    if ("data" in error) {
      const data = error.data
      if (typeof data === "object" && data !== null && "message" in data && typeof data.message === "string" && data.message) {
        return data.message
      }
    }
  }

  const text = String(error)
  if (text && text !== "[object Object]") return text
  const json = jsonOf(error)
  if (json) return json
  return "unknown error"
}

// A plain object still says something useful when it serializes; a cyclic one throws, and a
// diagnostic helper must not fail because the value it describes is broken.
function jsonOf(error: unknown) {
  try {
    const json = JSON.stringify(error)
    return json === "{}" || json === undefined ? "" : json
  } catch {
    return ""
  }
}
