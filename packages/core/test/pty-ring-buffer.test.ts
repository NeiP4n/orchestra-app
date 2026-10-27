import { describe, expect, it } from "bun:test"
import { AnsiRingBuffer } from "../src/pty"

describe("AnsiRingBuffer", () => {
  it("buffers chunks and calculates cursors accurately", () => {
    const buffer = new AnsiRingBuffer(100)
    expect(buffer.length).toBe(0)
    expect(buffer.startCursor).toBe(0)

    buffer.push("hello ")
    buffer.push("world\n")
    expect(buffer.length).toBe(12)
    expect(buffer.startCursor).toBe(0)

    const fullReplay = buffer.replay(0, 12)
    expect(fullReplay).toBe("hello world\n")

    const partialReplay = buffer.replay(6, 12)
    expect(partialReplay).toBe("world\n")

    const tailReplay = buffer.replay(12, 12)
    expect(tailReplay).toBe("")
  })

  it("evicts oldest chunks when exceeding buffer limit", () => {
    const limit = 20
    const buffer = new AnsiRingBuffer(limit)

    buffer.push("chunk-1;") // 8 chars
    buffer.push("chunk-2;") // 8 chars
    buffer.push("chunk-3;") // 8 chars -> total 24 chars > 20
    // chunk-1 should be evicted or partially trimmed
    expect(buffer.length).toBeLessThanOrEqual(limit)
    expect(buffer.startCursor).toBeGreaterThan(0)

    const replayed = buffer.replay(0, 24)
    expect(replayed).toContain("chunk-3;")
    expect(replayed.length).toBe(buffer.length)
  })

  it("preserves UTF-16 surrogate pairs when trimming excess output", () => {
    const buffer = new AnsiRingBuffer(10)
    // "12345" (5) + "🎨" (2 chars: \uD83C\uDFA8) + "6789" (4) = 11 chars
    buffer.push("12345")
    buffer.push("🎨")
    buffer.push("6789")

    expect(buffer.length).toBeLessThanOrEqual(10)
    const replay = buffer.replay(0, 11)
    // Ensure no broken lone surrogates
    for (let i = 0; i < replay.length; i++) {
      const code = replay.charCodeAt(i)
      if (code >= 0xd800 && code <= 0xdbff) {
        // High surrogate must be followed by low surrogate
        const next = replay.charCodeAt(i + 1)
        expect(next >= 0xdc00 && next <= 0xdfff).toBeTrue()
      }
    }
  })

  it("handles empty or negative offsets gracefully", () => {
    const buffer = new AnsiRingBuffer(50)
    buffer.push("data")
    expect(buffer.replay(10, 4)).toBe("")
    expect(buffer.replay(-1, 4)).toBe("data")
    expect(buffer.replay(4, 4)).toBe("")
  })

  it("handles ANSI escape sequences across chunks without breaking replay stream", () => {
    const buffer = new AnsiRingBuffer(100)
    const ansiColor = "\u001b[32mSUCCESS\u001b[0m\n"
    buffer.push(ansiColor)

    const replayed = buffer.replay(0, ansiColor.length)
    expect(replayed).toBe(ansiColor)
  })
})
