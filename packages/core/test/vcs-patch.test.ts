import { describe, expect, test } from "bun:test"
import { VcsPatch } from "@orchestra/core/vcs/patch"

// git quotes paths with non-ASCII bytes (as \NNN octal per byte when
// core.quotepath is on) and paths with control characters. The parser must
// decode both back to the real filename.
describe("VcsPatch quoted paths", () => {
  test("decodes octal-escaped non-ASCII names in ---/+++ headers", () => {
    const chunk = [
      'diff --git "a/\\320\\277\\321\\200\\320\\270\\320\\262\\320\\265\\321\\202.txt" "b/\\320\\277\\321\\200\\320\\270\\320\\262\\320\\265\\321\\202.txt"',
      "index 0000000..1111111 100644",
      '--- "a/\\320\\277\\321\\200\\320\\270\\320\\262\\320\\265\\321\\202.txt"',
      '+++ "b/\\320\\277\\321\\200\\320\\270\\320\\262\\320\\265\\321\\202.txt"',
      "@@ -0,0 +1 @@",
      "+privet",
    ].join("\n")
    expect(VcsPatch.fileFromPatchChunk(chunk)).toBe("привет.txt")
  })

  test("decodes octal-escaped names in diff --git headers without ---/+++", () => {
    const chunk = [
      'diff --git "a/\\320\\277\\321\\200\\320\\270\\320\\262\\320\\265\\321\\202.txt" "b/\\320\\277\\321\\200\\320\\270\\320\\262\\320\\265\\321\\202.txt"',
      "old mode 100644",
      "new mode 100755",
    ].join("\n")
    expect(VcsPatch.fileFromPatchChunk(chunk)).toBe("привет.txt")
  })

  test("decodes control-character escapes", () => {
    const chunk = ['--- "a/weird\\tname.txt"', '+++ "b/weird\\tname.txt"', "@@ -1 +1 @@", "-a", "+b"].join("\n")
    expect(VcsPatch.fileFromPatchChunk(chunk)).toBe("weird\tname.txt")
  })

  test("keeps literal UTF-8 next to octal-escaped bytes", () => {
    const chunk = ['--- "a/caf\\303\\251 \\342\\204\\2261.txt"', '+++ "b/caf\\303\\251 \\342\\204\\2261.txt"'].join("\n")
    expect(VcsPatch.fileFromPatchChunk(chunk)).toBe("café №1.txt")
  })

  test("chunksByFile groups octal-quoted chunks under the decoded name", () => {
    const patch = {
      text: [
        'diff --git "a/\\320\\277\\321\\200\\320\\270\\320\\262\\320\\265\\321\\202.txt" "b/\\320\\277\\321\\200\\320\\270\\320\\262\\320\\265\\321\\202.txt"',
        '--- "a/\\320\\277\\321\\200\\320\\270\\320\\262\\320\\265\\321\\202.txt"',
        '+++ "b/\\320\\277\\321\\200\\320\\270\\320\\262\\320\\265\\321\\202.txt"',
        "@@ -1 +1 @@",
        "-old",
        "+new",
        "diff --git a/plain.txt b/plain.txt",
        "--- a/plain.txt",
        "+++ b/plain.txt",
        "@@ -1 +1 @@",
        "-x",
        "+y",
      ].join("\n"),
      truncated: false,
    }
    const byFile = VcsPatch.chunksByFile(patch, () => undefined)
    expect([...byFile.keys()].sort()).toEqual(["plain.txt", "привет.txt"])
  })

  // Real `git diff` output for a file whose name contains U+0007 (bell):
  // git quotes it as \a, which JavaScript has no literal for.
  test("decodes the bell escape from real git output", () => {
    const chunk = [
      'diff --git "a/bell\\aname.txt" "b/bell\\aname.txt"',
      "index 587be6b..975fbec 100644",
      '--- "a/bell\\aname.txt"',
      '+++ "b/bell\\aname.txt"',
      "@@ -1 +1 @@",
      "-x",
      "+y",
    ].join("\n")
    expect(VcsPatch.fileFromPatchChunk(chunk)).toBe("bell\u0007name.txt")
  })

  test("leaves plain unquoted paths untouched", () => {
    const chunk = ["--- a/src/index.ts", "+++ b/src/index.ts", "@@ -1 +1 @@", "-a", "+b"].join("\n")
    expect(VcsPatch.fileFromPatchChunk(chunk)).toBe("src/index.ts")
  })
})
