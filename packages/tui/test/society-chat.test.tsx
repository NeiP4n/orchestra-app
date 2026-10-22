/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { Federation } from "@orchestra/schema/federation"
import { ConfigProvider } from "../src/config"
import { PromptRefProvider, usePromptRef } from "../src/context/prompt"
import { ThemeProvider } from "../src/context/theme"
import { CouncilResultsCard, ReplyOptions } from "../src/routes/session/society"
import { emptyThemeSource } from "./fixture/fixture"
import { TestTuiContexts } from "./fixture/tui-environment"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"

function Probe(props: { sent: string[] }) {
  const ref = usePromptRef()
  ref.set({
    focused: false,
    current: { text: "", files: [], agents: [], skills: [], pasted: [] },
    mode: "normal",
    setMode() {},
    set: (prompt: { text: string }) => void props.sent.push("set:" + prompt.text),
    reset() {},
    blur() {},
    focus() {},
    submit: () => void props.sent.push("submit"),
  } as never)
  return null
}

test("a reply option is drawn as a button and sends its text once", async () => {
  const sent: string[] = []
  const options = Federation.parseReplyOptions("Q?\n<reply-options>\n- Ship now | Ship it\n- Wait\n</reply-options>").options
  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <ThemeProvider mode="dark" source={emptyThemeSource}>
            <PromptRefProvider>
              <Probe sent={sent} />
              <ReplyOptions options={options} />
            </PromptRefProvider>
          </ThemeProvider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 60, height: 8 },
  )
  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes("Ship now"))
  const frame = app.captureCharFrame()
  expect(frame).toContain("▸ Ship now")
  expect(frame).toContain("▸ Wait")
  const lines = frame.split("\n")
  const y = lines.findIndex((line) => line.includes("▸ Ship now"))
  const x = lines[y]!.indexOf("▸ Ship now") + 2
  await app.mockMouse.click(x, y)
  await app.renderOnce()
  expect(sent).toEqual(["set:Ship it", "submit"])
  await app.mockMouse.click(x, y)
  expect(sent).toHaveLength(2)
  expect(app.captureCharFrame()).toContain("✓ Ship now")
  app.renderer.destroy()
})

test("council results are drawn as one card per call sign", async () => {
  const results = Federation.parseCouncilResults(
    [
      '<group-council-results id="c1" group="Shop">',
      "Original subject: Add search",
      '<proposal project="Web" callsign="Atlas">\nUse a form\n</proposal>',
      '<proposal project="API" callsign="Borei">\nAdd an index\n</proposal>',
      "</group-council-results>",
    ].join("\n"),
  )!
  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <ThemeProvider mode="dark" source={emptyThemeSource}>
            <CouncilResultsCard results={results} />
          </ThemeProvider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 70, height: 20 },
  )
  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes("Add an index"))
  const frame = app.captureCharFrame()
  for (const text of ["Совет", "Add search", "Atlas", "Web", "Use a form", "Borei", "API", "Add an index"])
    expect(frame).toContain(text)
  app.renderer.destroy()
})
