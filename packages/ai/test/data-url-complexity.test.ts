import { expect, test } from "bun:test"
import { parseDataUrl } from "../src/media.js"

// The delimiter cannot belong to both a parameter and the next parameter.
// Bound a separate process so a regression cannot lock the test runner's event loop.
test("malformed semicolon headers do not cause data URL backtracking", async () => {
  const module = new URL("../src/media.ts", import.meta.url).href
  const source = `import { parseDataUrl } from ${JSON.stringify(module)};
    for (let n = 0; n < 40; n++) {
      if (parseDataUrl('data:image/png;' + ';'.repeat(1000) + ',broken') !== undefined)
        throw Error('malformed header accepted');
    }`
  const child = Bun.spawn([process.execPath, "--eval", source], { stdout: "pipe", stderr: "pipe" })
  const timer = setTimeout(() => child.kill(), 3000)
  try {
    expect(await child.exited).toBe(0)
    expect(await new Response(child.stderr).text()).toBe("")
  } finally {
    clearTimeout(timer)
    child.kill()
  }
}, 5000)

test("data URL delimiter boundaries preserve parameter and payload behavior", () => {
  for (const [header, accepted] of [
    ["image/png", false],
    ["image/png;base64", true],
    ["image/png;charset=utf-8;base64", true],
    ["image/png;;;charset=x;;base64", true],
    ["image/png;BASE64", false],
    [";base64", false],
    ["image/png;base64;other", false],
  ] as const) {
    for (const payload of ["", "AQID", "a,b", "a\nb"]) {
      const parsed = parseDataUrl(`data:${header},${payload}`)
      expect(parsed?.source).toEqual(accepted ? { type: "base64", data: payload, mediaType: "image/png" } : undefined)
    }
  }
})
