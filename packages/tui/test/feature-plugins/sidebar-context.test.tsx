/** @jsxImportSource @opentui/solid */
import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import type { Context } from "@orchestra/plugin/tui/context"
import { ConfigProvider } from "../../src/config"
import { SidebarContext } from "../../src/feature-plugins/sidebar/context"
import { ThemeProvider } from "../../src/context/theme"
import { setActiveLanguage } from "../../src/util/i18n"
import { configureExchangeRate, exchangeRate } from "../../src/util/money"
import { emptyThemeSource } from "../fixture/fixture"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"

// These expectations are English; pin the suite language explicitly (the default is "en",
// but other files in the same process may switch it and not restore).
beforeAll(() => setActiveLanguage("en"))
afterAll(() => setActiveLanguage("en"))

function context(options?: {
  cost?: number
  tokens?: number
  limit?: number
  actionColor?: boolean
  directory?: string
  openPanel?: (name: string) => boolean
}) {
  const color = RGBA.fromInts(200, 200, 200)
  return {
    theme: {
      // Hover tokens are intentionally absent; DoD must use its visible color fallback.
      background: { base: RGBA.fromInts(20, 20, 20) },
      increase: () => RGBA.fromInts(60, 60, 60),
      text: {
        base: color,
        muted: color,
        ...(options?.actionColor === false ? {} : { action: { primary: { base: color } } }),
        feedback: { success: { base: color }, info: { base: color }, warning: { base: color }, error: { base: color } },
      },
    },
    data: {
      session: {
        get: () => ({ location: { directory: options?.directory ?? "/workspace" } }),
        cost: () => options?.cost ?? 0,
        message: {
          list: () =>
            options?.tokens
              ? [
                  {
                    id: "message",
                    type: "assistant",
                    model: { providerID: "provider", id: "model" },
                    tokens: {
                      input: options.tokens,
                      output: 0,
                      reasoning: 0,
                      cache: { read: 0, write: 0 },
                    },
                  },
                ]
              : [],
        },
      },
      location: {
        model: {
          list: () =>
            options?.limit ? [{ providerID: "provider", id: "model", limit: { context: options.limit } }] : [],
        },
      },
    },
    ui: {
      panel: {
        open: (name: string) => options?.openPanel?.(name) ?? true,
      },
    },
  } as unknown as Context
}

test("keeps Context scopes available before usage, without invented usage values", async () => {
  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <ThemeProvider mode="dark" source={emptyThemeSource}>
            <SidebarContext context={context()} sessionID="session" />
          </ThemeProvider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 42, height: 8 },
  )

  try {
    await app.renderOnce()
    await app.waitForFrame((frame) => frame.trim() !== "")
    const frame = app.captureCharFrame()
    // The section always renders since 69d512cc: heading and scope controls stay available.
    expect(frame).toContain("Context")
    expect(frame).toContain("Session")
    expect(frame).toContain("Project")
    expect(frame).toContain("Group")
    // Zero-data fixture: no usage values may be invented.
    expect(frame).not.toContain("%")
    expect(frame).not.toContain("tokens")
    expect(frame).not.toContain("spent")
    expect(frame).not.toContain("█")
    expect(frame).not.toContain("░")
    expect(frame).not.toContain("Not measured")
  } finally {
    app.renderer.destroy()
  }
})

test("sidebar shows available context usage", async () => {
  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <ThemeProvider mode="dark" source={emptyThemeSource}>
            <SidebarContext context={context({ tokens: 1234 })} sessionID="session" />
          </ThemeProvider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 42, height: 8 },
  )

  try {
    await app.renderOnce()
    await app.waitForFrame((frame) => frame.trim() !== "")
    expect(app.captureCharFrame()).toContain("Context")
    expect(app.captureCharFrame()).toContain("1.2K tokens")
  } finally {
    app.renderer.destroy()
  }
})

test("sidebar shows usage against the model context limit", async () => {
  // Pin the exchange rate so the money literal below is deterministic.
  const previousRate = exchangeRate()
  configureExchangeRate(80)
  let app: Awaited<ReturnType<typeof testRender>> | undefined
  try {
    app = await testRender(
      () => (
        <TestTuiContexts>
          <ConfigProvider config={createTuiResolvedConfig()}>
            <ThemeProvider mode="dark" source={emptyThemeSource}>
              <SidebarContext context={context({ tokens: 150000, limit: 200000, cost: 1.5 })} sessionID="session" />
            </ThemeProvider>
          </ConfigProvider>
        </TestTuiContexts>
      ),
      { width: 42, height: 8 },
    )

    await app.renderOnce()
    await app.waitForFrame((frame) => frame.trim() !== "")
    const frame = app.captureCharFrame()
    expect(frame).toContain("75% used")
    expect(frame).toContain("█")
    expect(frame).toContain("150.0K / 200.0K tokens")
    // formatMoney(1.5 USD) at the pinned 80 RUB/USD rate, ru-RU currency with a real NBSP.
    expect(frame).toContain("120,00\u00A0₽ spent")
  } finally {
    configureExchangeRate(previousRate)
    app?.renderer.destroy()
  }
})

test("only the explicit Open button launches the existing DoD task panel and keeps hover feedback without an action theme color", async () => {
  const opened: string[] = []
  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <ThemeProvider mode="dark" source={emptyThemeSource}>
            <SidebarContext
              context={context({
                actionColor: false,
                openPanel: (name) => {
                  opened.push(name)
                  return true
                },
              })}
              sessionID="session"
            />
          </ThemeProvider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 72, height: 12 },
  )

  try {
    await app.renderOnce()
    await app.waitForFrame((frame) => frame.trim() !== "")
    let frame = app.captureCharFrame()
    expect(frame).toContain("DoD")
    let lines = frame.split("\n")
    let y = lines.findIndex((line) => line.includes("DoD"))
    expect(y).toBeGreaterThanOrEqual(0)

    // The preview chevron is a separate control: it must not launch the task panel.
    const toggleX = lines[y].indexOf("▸")
    expect(toggleX).toBeGreaterThanOrEqual(0)
    await app.mockMouse.click(toggleX, y)
    await app.renderOnce()
    expect(opened).toEqual([])

    // Clicking the title or progress text is informational only; only [Open] launches the panel.
    frame = app.captureCharFrame()
    lines = frame.split("\n")
    y = lines.findIndex((line) => line.includes("DoD"))
    const titleX = lines[y].indexOf("DoD")
    await app.mockMouse.click(titleX, y)
    await app.renderOnce()
    expect(opened).toEqual([])

    frame = app.captureCharFrame()
    lines = frame.split("\n")
    y = lines.findIndex((line) => line.includes("DoD"))
    const openX = lines[y].indexOf("[Open]")
    expect(openX).toBeGreaterThanOrEqual(0)
    await app.mockMouse.click(openX, y)
    await app.renderOnce()
    expect(opened).toEqual(["orchestra.sidebar.dod"])
  } finally {
    app.renderer.destroy()
  }
})

test("sidebar DoD progress bar reflects completed project tasks", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "opencode-sidebar-dod-"))
  await mkdir(path.join(directory, ".opencode"), { recursive: true })
  await writeFile(
    path.join(directory, ".opencode", "dod.yaml"),
    [
      "stages: []",
      "leaves:",
      "  - id: L-001",
      "    what: Implement feature",
      "    task_state: DONE",
      "    steps:",
      '      - "[x] Implement"',
      "  - id: L-002",
      "    what: Verify feature",
      "    task_state: IN_PROGRESS",
      "    steps:",
      '      - "[ ] Verify"',
      "",
    ].join("\n"),
    "utf8",
  )
  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <ThemeProvider mode="dark" source={emptyThemeSource}>
            <SidebarContext context={context({ directory })} sessionID="session" />
          </ThemeProvider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 72, height: 16 },
  )

  try {
    await app.renderOnce()
    await app.waitForFrame((frame) => frame.trim() !== "")
    const started = Date.now()
    let frame = ""
    while (Date.now() - started < 3_000) {
      await app.renderOnce()
      frame = app.captureCharFrame()
      if (frame.includes("50%")) break
      await Bun.sleep(20)
    }
    expect(frame).toContain("DoD")
    expect(frame).toContain("1/2")
    expect(frame).toContain("50%")
    expect(frame).toMatch(/━{10,}─{10,}/)
  } finally {
    app.renderer.destroy()
    await rm(directory, { recursive: true, force: true })
  }
})
