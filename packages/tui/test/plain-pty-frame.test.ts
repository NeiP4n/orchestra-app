import { expect, test } from "bun:test"
import { decodePtyFrame } from "../src/util/plain-pty-frame"

test("output frames pass through and the cursor control frame is dropped", () => {
  const text = new TextEncoder().encode("ls\r\n")
  expect(decodePtyFrame(text.buffer.slice(0) as ArrayBuffer)).toEqual(text)
  expect(decodePtyFrame("hello")).toEqual(new TextEncoder().encode("hello"))
  const meta = new Uint8Array([0, ...new TextEncoder().encode('{"cursor":4}')])
  expect(decodePtyFrame(meta.buffer)).toBeUndefined()
  expect(decodePtyFrame("")).toBeUndefined()
  expect(decodePtyFrame(42)).toBeUndefined()
})
