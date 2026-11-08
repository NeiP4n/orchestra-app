// Frames of the plain PTY websocket: raw terminal output, plus one control frame that starts with a 0x00
// byte and carries the output cursor as JSON. Only the output is for the screen.
export function decodePtyFrame(data: unknown): Uint8Array | undefined {
  if (typeof data === "string")
    return data.length > 0 && data.charCodeAt(0) !== 0 ? new TextEncoder().encode(data) : undefined
  if (data instanceof ArrayBuffer) {
    const bytes = new Uint8Array(data)
    return bytes.length > 0 && bytes[0] !== 0 ? bytes : undefined
  }
  if (data instanceof Uint8Array) return data.length > 0 && data[0] !== 0 ? data : undefined
  return undefined
}
