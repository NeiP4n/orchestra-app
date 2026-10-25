import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { ConfigProvider } from "../src/config"
import { ClientProvider } from "../src/context/client"
import { Keymap } from "../src/context/keymap"
import { ThemeProvider, useTheme } from "../src/context/theme"
import { SidebarContext } from "../src/feature-plugins/sidebar/context"
import { createApi, createFetch } from "./fixture/tui-client"
import { TestTuiContexts } from "./fixture/tui-environment"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"

async function mount() {
  const directory = await mkdtemp(path.join(tmpdir(), "sidebar-context-"))
  const messages = [
    {
      id: "msg_1",
      type: "assistant",
      model: { providerID: "p", id: "m" },
      tokens: { input: 1000, output: 200, reasoning: 0, cache: { read: 7000, write: 800 } },
    },
  ]

  function Block() {
    const theme = useTheme()
    const context = {
      theme,
      data: {
        session: {
          message: { list: () => messages },
          get: () => ({ id: "ses_1", location: { directory } }),
          cost: () => 1.5,
        },
        location: { model: { list: () => [{ providerID: "p", id: "m", limit: { context: 20000 } }] } },
      },
      location: { directory },
      ui: { format: { path: (value: string) => value }, dialog: {} },
    } as unknown as Parameters<typeof SidebarContext>[0]["context"]
    return (
      <box width={40} height={30}>
        <SidebarContext context={context} sessionID="ses_1" />
      </box>
    )
  }

  const setup = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <Keymap.Provider>
            <ClientProvider api={createApi(createFetch().fetch)}>
              <ThemeProvider mode="dark" source={{ discover: async () => ({}) }}>
                <Block />
              </ThemeProvider>
            </ClientProvider>
          </Keymap.Provider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 40, height: 30 },
  )
  const frame = async (ready: (text: string) => boolean) => {
    for (let index = 0; index < 60; index++) {
      await setup.renderOnce()
      const text = setup.captureCharFrame()
      if (ready(text)) return text.split("\n")
      await Bun.sleep(20)
    }
    throw new Error(setup.captureCharFrame())
  }
  return { setup, frame }
}

test("the session scope splits the window by token kind and offers project and group", async () => {
  const { setup, frame } = await mount()
  try {
    const lines = await frame((text) => text.includes("Cache read"))
    const text = lines.join("\n")
    expect(text).toContain("Context")
    expect(text).toContain("45% used")
    expect(text).toContain("Session")
    expect(text).toContain("Project")
    expect(text).toContain("Group")
    expect(text).toContain("Input")
    expect(text).toContain("Cache write")
    expect(text).toContain("Free space")
    expect(text).toContain("$1.50 spent")

    const row = lines.findIndex((line) => line.includes("Project"))
    await setup.mockMouse.click(lines[row].indexOf("Project") + 1, row)
    const scoped = (await frame((value) => value.includes("does not belong") || value.includes("Loading") || value.includes("Could not")))
      .join("\n")
    expect(scoped).not.toContain("Cache read")
  } finally {
    setup.renderer.destroy()
  }
})
