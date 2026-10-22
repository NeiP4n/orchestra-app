import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { ConfigProvider } from "../../src/config"
import { Keymap } from "../../src/context/keymap"
import { ThemeProvider, useTheme } from "../../src/context/theme"
import { ToastProvider } from "../../src/ui/toast"
import { DialogProvider } from "../../src/ui/dialog"
import { PromptMiniSkills } from "../../src/component/prompt/mini-skills"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"

// The prompt as far as the bar sees it: its bordered, tinted box with the input below.
function Prompt(props: { onInsert?: (text: string) => void }) {
  const theme = useTheme()
  return (
    <box border={["left"]} width="100%" backgroundColor={theme.decrease(theme.background.raised.base)} paddingLeft={2}>
      <PromptMiniSkills mode={() => "normal"} onInsert={props.onInsert ?? (() => {})} />
      <text>prompt input</text>
    </box>
  )
}

async function render(state: string, width: number, onInsert?: (text: string) => void) {
  const setup = await testRender(
    () => (
      <TestTuiContexts paths={{ state }}>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <Keymap.Provider>
            <ThemeProvider mode="dark" source={{ discover: async () => ({}) }}>
              <ToastProvider>
                <DialogProvider>
                  <Prompt onInsert={onInsert} />
                </DialogProvider>
              </ToastProvider>
            </ThemeProvider>
          </Keymap.Provider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width, height: 24 },
  )
  const settle = async () => {
    for (let index = 0; index < 8; index++) {
      await setup.renderOnce()
      await Bun.sleep(15)
    }
  }
  await settle()
  return { setup, settle }
}

test("the bar is the prompt's top line and lights the chip under the pointer", async () => {
  const state = await mkdtemp(path.join(tmpdir(), "mini-skills-"))
  const { setup, settle } = await render(state, 70)
  try {
    const lines = setup.captureCharFrame().split("\n")
    expect(lines[0]).toContain("◎ Analyze")
    expect(lines[0]).toContain("⚙ Skills")
    // what does not fit goes behind +N instead of being cut
    expect(lines[0]).toMatch(/\+\d/)
    expect(lines[2]).toContain("prompt input")

    const chip = (spans: ReturnType<typeof setup.captureSpans>) =>
      spans.lines[0].spans.find((span) => span.text.includes("Plan"))!
    const idle = chip(setup.captureSpans())
    await setup.mockMouse.moveTo(lines[0].indexOf("Plan") + 1, 0)
    await settle()
    expect(chip(setup.captureSpans()).bg.toString()).not.toBe(idle.bg.toString())
  } finally {
    setup.renderer.destroy()
  }
})

test("space in the manager hides a skill from the bar and keeps it in the list", async () => {
  const state = await mkdtemp(path.join(tmpdir(), "mini-skills-"))
  const { setup, settle } = await render(state, 120)
  try {
    const top = setup.captureCharFrame().split("\n")[0]
    await setup.mockMouse.click(top.indexOf("Skills"), 0)
    await settle()
    expect(setup.captureCharFrame()).toContain("Mini skills")
    setup.mockInput.pressKey(" ")
    await settle()
    const saved = JSON.parse(await readFile(path.join(state, "mini-skills.json"), "utf8")) as {
      items: { id: string; hidden?: boolean }[]
    }
    expect(saved.items.find((item) => item.id === "analyze")?.hidden).toBe(true)
    expect(saved.items.map((item) => item.id)).toContain("analyze")
    setup.mockInput.pressEscape()
    await settle()
    expect(setup.captureCharFrame().split("\n")[0]).not.toContain("Analyze")
  } finally {
    setup.renderer.destroy()
  }
})

test("dragging a chip along the bar reorders it, and the drop does not insert its text", async () => {
  const state = await mkdtemp(path.join(tmpdir(), "mini-skills-"))
  const inserted: string[] = []
  const { setup, settle } = await render(state, 120, (text) => inserted.push(text))
  try {
    const top = () => setup.captureCharFrame().split("\n")[0]
    const start = top().indexOf("Analyze")
    await setup.mockMouse.drag(start + 1, 0, top().indexOf("Debug") + 1, 0)
    await settle()
    expect(top().indexOf("Analyze")).toBeGreaterThan(top().indexOf("Debug"))
    const saved = JSON.parse(await readFile(path.join(state, "mini-skills.json"), "utf8")) as {
      items: { id: string }[]
    }
    expect(saved.items.map((item) => item.id).slice(0, 3)).toEqual(["plan", "debug", "analyze"])
    expect(inserted).toEqual([])
    // the drag moved the chip, it did not select its text
    expect(setup.renderer.getSelection()?.getSelectedText() ?? "").toBe("")
    // led back over its old neighbour it returns to the start
    await setup.mockMouse.drag(top().indexOf("Analyze") + 1, 0, top().indexOf("Plan") + 1, 0)
    await settle()
    expect(top().indexOf("Analyze")).toBeLessThan(top().indexOf("Plan"))
    // a plain click still inserts
    await setup.mockMouse.click(top().indexOf("Plan") + 1, 0)
    await settle()
    expect(inserted).toHaveLength(1)
  } finally {
    setup.renderer.destroy()
  }
})

test("a right click on a chip opens its menu, and Remove takes it off", async () => {
  const state = await mkdtemp(path.join(tmpdir(), "mini-skills-"))
  const { setup, settle } = await render(state, 120)
  try {
    const top = () => setup.captureCharFrame().split("\n")[0]
    await setup.mockMouse.click(top().indexOf("Review") + 1, 0, 2)
    await settle()
    const lines = setup.captureCharFrame().split("\n")
    const row = lines.findIndex((line) => line.includes("Remove"))
    expect(row).toBeGreaterThan(0)
    await setup.mockMouse.click(lines[row].indexOf("Remove") + 1, row)
    await settle()
    expect(top()).not.toContain("Review")
    const saved = JSON.parse(await readFile(path.join(state, "mini-skills.json"), "utf8")) as {
      items: { id: string }[]
    }
    expect(saved.items.map((item) => item.id)).not.toContain("review")
  } finally {
    setup.renderer.destroy()
  }
})
