/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { ErrorCard, FoldedText } from "../src/routes/session/fold"
import { ConfigProvider } from "../src/config"
import { ThemeProvider } from "../src/context/theme"
import { errorHeadline, errorIsLong, foldRows } from "../src/util/fold"
import { emptyThemeSource } from "./fixture/fixture"
import { TestTuiContexts } from "./fixture/tui-environment"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"

const zen =
  "Error: Zen's free tier counts requests per IP address, and this address has used its daily allowance until the daily reset. Retrying from the same address cannot help: turn on OpenCode-only WARP routing and Auto IP to continue from another address, or choose another model."

describe("folding rules", () => {
  test("short text is left alone and long text keeps its first rows", () => {
    expect(foldRows("one\ntwo", 40, 4)).toEqual({ head: "one\ntwo", hidden: 0 })
    const folded = foldRows(Array.from({ length: 10 }, (_, n) => `line ${n}`).join("\n"), 40, 3)
    expect(folded.head).toBe("line 0\nline 1\nline 2")
    expect(folded.hidden).toBe(7)
  })

  test("a single long paragraph is cut by rows, not by lines", () => {
    const folded = foldRows("x".repeat(300), 50, 2)
    expect(folded.head.length).toBeLessThanOrEqual(101)
    expect(folded.head.endsWith("…")).toBe(true)
    expect(folded.hidden).toBe(4)
  })

  test("an error is known by its first sentence and counts as long only past two rows", () => {
    const headline = errorHeadline(zen)
    expect(headline.length).toBeLessThanOrEqual(100)
    expect(headline.startsWith("Error: Zen's free tier counts requests per IP address")).toBe(true)
    expect(headline.endsWith("daily…")).toBe(true)
    expect(errorHeadline("Connection refused")).toBe("Connection refused")
    expect(errorIsLong(zen, 60)).toBe(true)
    expect(errorIsLong("Connection refused", 60)).toBe(false)
  })
})

async function render(view: () => unknown, width = 70, height = 20) {
  const app = await testRender(
    () => (
      <TestTuiContexts directory="/tmp/opencode/packages/tui">
        <ConfigProvider config={createTuiResolvedConfig()}>
          <ThemeProvider mode="dark" source={emptyThemeSource}>
            {view() as never}
          </ThemeProvider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width, height },
  )
  await app.renderOnce()
  await app.waitForFrame((frame) => frame.trim() !== "")
  return app
}

async function click(app: Awaited<ReturnType<typeof render>>, label: string) {
  const lines = app.captureCharFrame().split("\n")
  const y = lines.findIndex((line) => line.includes(label))
  expect(y).toBeGreaterThanOrEqual(0)
  await app.mockMouse.click(lines[y]!.indexOf(label) + 1, y)
}

describe("error card", () => {
  test("a long error collapses to one line and opens on a click", async () => {
    const app = await render(() => <ErrorCard message={zen} width={62} />)
    const collapsed = app.captureCharFrame()
    expect(collapsed).toContain("▸ подробнее")
    expect(collapsed).toContain("✗")
    expect(collapsed).not.toContain("OpenCode-only")
    await click(app, "▸ подробнее")
    await app.waitForFrame((frame) => frame.includes("OpenCode-only"))
    expect(app.captureCharFrame()).toContain("▾ свернуть")
    await click(app, "▾ свернуть")
    await app.waitForFrame((frame) => !frame.includes("OpenCode-only"))
  })

  test("a short error stays a single plain line with no toggle", async () => {
    const app = await render(() => <ErrorCard message="Connection refused" width={62} />)
    const frame = app.captureCharFrame()
    expect(frame).toContain("✗ Connection refused")
    expect(frame).not.toContain("подробнее")
  })
})

describe("folded text", () => {
  const long = Array.from({ length: 14 }, (_, n) => `строка ${n}`).join("\n")

  test("shows the first rows with a count of the rest and opens on a click", async () => {
    const app = await render(() => <FoldedText text={long} width={60} maxRows={5} />)
    const frame = app.captureCharFrame()
    expect(frame).toContain("строка 4")
    expect(frame).not.toContain("строка 5")
    expect(frame).toContain("▸ ещё 9 строк")
    await click(app, "▸ ещё 9 строк")
    await app.waitForFrame((current) => current.includes("строка 13"))
  })

  test("text that fits has no toggle", async () => {
    const app = await render(() => <FoldedText text={"коротко"} width={60} maxRows={5} />)
    expect(app.captureCharFrame()).not.toContain("ещё")
  })
})
