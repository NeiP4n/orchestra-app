/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { OutlineRail } from "../src/routes/session/outline-view"
import { ConfigProvider } from "../src/config"
import { ThemeProvider } from "../src/context/theme"
import { Keymap } from "../src/context/keymap"
import { emptyThemeSource } from "./fixture/fixture"
import { TestTuiContexts } from "./fixture/tui-environment"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"

test("clicking outline topic executes jump on mouse_up and stops event propagation so message dialog is not triggered", async () => {
  let jumpedRef: any = null
  let backgroundMouseUps = 0
  let backgroundMouseDowns = 0

  const categories = [
    {
      key: "msg_user_1",
      title: "Design architectural blueprint",
      ref: { messageID: "msg_user_1", partID: "message" },
      messageIDs: ["msg_user_1", "msg_asst_1"],
      entries: [
        {
          key: "sec_1",
          title: "Step 1: Layers",
          ref: { messageID: "msg_user_1", partID: "part_1" },
        },
      ],
    },
    {
      key: "msg_user_2",
      title: "Implement database connectors",
      ref: { messageID: "msg_user_2", partID: "message" },
      messageIDs: ["msg_user_2"],
      entries: [],
    },
  ]

  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={createTuiResolvedConfig({ theme: { name: "opencode", mode: "dark" } })}>
          <ThemeProvider mode="dark" source={emptyThemeSource}>
            <Keymap.Provider>
              <box
                width={80}
                height={20}
                position="relative"
                onMouseDown={() => {
                  backgroundMouseDowns++
                }}
                onMouseUp={() => {
                  backgroundMouseUps++
                }}
              >
                <OutlineRail
                  categories={categories}
                  active={{ category: "msg_user_1" }}
                  height={20}
                  maxWidth={40}
                  right={0}
                  onJump={(ref) => {
                    jumpedRef = ref
                  }}
                />
              </box>
            </Keymap.Provider>
          </ThemeProvider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 80, height: 20 },
  )

  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes("──") || frame.includes("━━"))

  // Rail is at right edge, let's hover to open outline
  const railX = 78
  const railY = 0
  await app.mockMouse.moveTo(railX, railY)
  await app.waitForFrame((frame) => frame.includes("Chat outline"))

  // Click on the topic "Design architectural blueprint"
  const lines = app.captureCharFrame().split("\n")
  const topicRow = lines.findIndex((l) => l.includes("Design architectural blueprint"))
  expect(topicRow).toBeGreaterThanOrEqual(0)
  const topicCol = lines[topicRow].indexOf("Design architectural blueprint")

  // Send mouse down
  await app.mockMouse.pressDown(topicCol, topicRow)
  expect(jumpedRef).toBeNull() // Should NOT jump on mouse down!
  expect(backgroundMouseDowns).toBe(0) // Must NOT bleed to background!

  // Send mouse up (release)
  await app.mockMouse.release(topicCol, topicRow)
  expect(jumpedRef).toEqual({ messageID: "msg_user_1", partID: "message" }) // Jump on mouse up!
  expect(backgroundMouseUps).toBe(0) // Crucial: mouse up must NOT bleed to background!
})
