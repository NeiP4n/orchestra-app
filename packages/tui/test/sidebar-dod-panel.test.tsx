import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { ConfigProvider } from "../src/config"
import { Keymap } from "../src/context/keymap"
import { ThemeProvider, useTheme } from "../src/context/theme"
import { SidebarDodPanel } from "../src/feature-plugins/sidebar/dod"
import { TestTuiContexts } from "./fixture/tui-environment"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"

// A board long enough that its task list wants more height than the panel has.
const board = [
  "leaves:",
  ...Array.from({ length: 30 }, (_, index) =>
    [`  - id: T-${index}`, `    what: "Task ${index}"`, `    task_state: ${index < 18 ? "DONE" : "NOT_STARTED"}`].join(
      "\n",
    ),
  ),
].join("\n")

async function mount(text: string, height: number, onClose = () => {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "dod-panel-"))
  await mkdir(path.join(directory, ".opencode"), { recursive: true })
  await writeFile(path.join(directory, ".opencode", "dod.yaml"), text)

  function Panel() {
    const theme = useTheme()
    const context = {
      theme,
      data: { session: { get: () => ({ location: { directory } }) } },
      location: { directory },
      ui: { format: { path: (value: string) => value } },
    } as unknown as Parameters<typeof SidebarDodPanel>[0]["context"]
    const panel = { sessionID: "ses_1", width: 40, close: onClose } as unknown as Parameters<
      typeof SidebarDodPanel
    >[0]["panel"]
    return (
      <box width={40} height={height}>
        <SidebarDodPanel context={context} panel={panel} />
      </box>
    )
  }

  const setup = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <Keymap.Provider>
            <ThemeProvider mode="dark" source={{ discover: async () => ({}) }}>
              <Panel />
            </ThemeProvider>
          </Keymap.Provider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 40, height },
  )
  const frame = async (ready: (text: string) => boolean) => {
    for (let index = 0; index < 40; index++) {
      await setup.renderOnce()
      const text = setup.captureCharFrame()
      if (ready(text)) return text.split("\n")
      await Bun.sleep(20)
    }
    throw new Error(setup.captureCharFrame())
  }
  return { setup, frame }
}

test("the panel's close control stays clear of the progress line on a short panel and closes it", async () => {
  let closed = 0
  const { setup, frame } = await mount(board, 12, () => closed++)
  try {
    const lines = await frame((text) => text.includes("18/30"))
    const closeRow = lines.findIndex((line) => line.includes("Close ✕"))
    const progressRow = lines.findIndex((line) => line.includes("18/30 · 60%"))
    expect(closeRow).toBeGreaterThanOrEqual(0)
    expect(lines[closeRow]).toContain("Project DoD")
    expect(progressRow).toBeGreaterThan(closeRow)
    await setup.mockMouse.click(lines[closeRow].indexOf("Close") + 1, closeRow)
    expect(closed).toBe(1)
  } finally {
    setup.renderer.destroy()
  }
})

test("the list starts on unfinished work, failures first, and a task opens to its checklist", async () => {
  const { setup, frame } = await mount(
    [
      "leaves:",
      "  - id: L-1",
      '    what: "Shipped"',
      "    task_state: DONE",
      "  - id: L-2",
      '    what: "Later"',
      "  - id: L-3",
      '    what: "Broken"',
      "    task_state: FAILED",
      "    owner: Alex",
      "    depends_on: [L-2]",
      "    steps:",
      '      - "[x] reproduce"',
      '      - "[ ] fix"',
    ].join("\n"),
    24,
  )
  try {
    const lines = await frame((text) => text.includes("Broken"))
    const text = lines.join("\n")
    expect(text).toContain("Unfinished 2")
    expect(text).toContain("Finished 1")
    expect(text).not.toContain("Shipped")
    expect(lines.findIndex((line) => line.includes("Broken"))).toBeLessThan(
      lines.findIndex((line) => line.includes("Later")),
    )

    const row = lines.findIndex((line) => line.includes("Broken"))
    await setup.mockMouse.click(lines[row].indexOf("Broken") + 1, row)
    const open = (await frame((value) => value.includes("reproduce"))).join("\n")
    expect(open).toContain("taken by Alex")
    expect(open).toContain("Waits for L-2")
    expect(open).toContain("✓ reproduce")
    expect(open).toContain("○ fix")

    const chips = (await frame(() => true)).findIndex((line) => line.includes("Finished 1"))
    const chipLine = setup.captureCharFrame().split("\n")[chips]
    await setup.mockMouse.click(chipLine.indexOf("Finished") + 1, chips)
    const done = (await frame((value) => value.includes("Shipped"))).join("\n")
    expect(done).not.toContain("Broken")
  } finally {
    setup.renderer.destroy()
  }
})
