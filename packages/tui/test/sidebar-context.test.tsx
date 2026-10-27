import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { ConfigProvider } from "../src/config"
import { ClientProvider } from "../src/context/client"
import { Keymap } from "../src/context/keymap"
import { ThemeProvider, useTheme } from "../src/context/theme"
import {
  computeBarCells,
  estimateToolTokens,
  extractServerCompactionThreshold,
  formatCompactionThreshold,
  parseCompactionThreshold,
  saveDirectFallback,
  SidebarContext,
} from "../src/feature-plugins/sidebar/context"
import { createApi, createFetch } from "./fixture/tui-client"
import { TestTuiContexts } from "./fixture/tui-environment"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"

async function mount(options?: {
  messages?: any[]
  language?: "en" | "ru"
  serverConfig?: any
  onPrompt?: (opts: any) => Promise<string | undefined>
  onConfirm?: (opts: any) => Promise<boolean | undefined>
  onConfigUpdate?: (data: any) => Promise<any>
  onSessionUpdate?: (data: any) => Promise<any>
}) {
  const directory = await mkdtemp(path.join(tmpdir(), "sidebar-context-"))
  const messages = options?.messages ?? [
    {
      id: "msg_1",
      type: "assistant",
      model: { providerID: "p", id: "m" },
      tokens: { input: 1000, output: 200, reasoning: 0, cache: { read: 7000, write: 800 } },
    },
  ]

  let clientConfigUpdateCalled: any = null
  let clientSessionUpdateCalled: any = null

  function Block() {
    const theme = useTheme()
    const context = {
      theme,
      client: {
        session: {
          update: async (data: any) => {
            clientSessionUpdateCalled = data
            if (options?.onSessionUpdate) return options.onSessionUpdate(data)
            return data
          },
        },
        config: {
          get: async () => options?.serverConfig ?? undefined,
          update: async (data: any) => {
            clientConfigUpdateCalled = data
            if (options?.onConfigUpdate) return options.onConfigUpdate(data)
            return data
          },
        },
      },
      data: {
        session: {
          message: { list: () => messages },
          get: () => ({ id: "ses_1", location: { directory } }),
          cost: () => 1.5,
        },
        location: { model: { list: () => [{ providerID: "p", id: "m", limit: { context: 20000 } }] } },
      },
      location: { directory },
      ui: {
        format: { path: (value: string) => value },
        dialog: {
          prompt: options?.onPrompt ?? (async () => undefined),
          confirm: options?.onConfirm ?? (async () => undefined),
        },
      },
    } as unknown as Parameters<typeof SidebarContext>[0]["context"]
    return (
      <box width={40} height={35}>
        <SidebarContext context={context} sessionID="ses_1" />
      </box>
    )
  }

  const baseApi = createApi(createFetch().fetch)
  const apiWithConfigUpdate = {
    ...baseApi,
    config: {
      ...baseApi.config,
      get: async () => options?.serverConfig ?? undefined,
      update: options?.onConfigUpdate ?? baseApi.config.update,
    },
  }

  const setup = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={createTuiResolvedConfig({ language: options?.language })}>
          <Keymap.Provider>
            <ClientProvider api={apiWithConfigUpdate}>
              <ThemeProvider mode="dark" source={{ discover: async () => ({}) }}>
                <Block />
              </ThemeProvider>
            </ClientProvider>
          </Keymap.Provider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 40, height: 35 },
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
  return {
    setup,
    frame,
    getClientConfigUpdate: () => clientConfigUpdateCalled,
    getClientSessionUpdate: () => clientSessionUpdateCalled,
  }
}

test("estimateToolTokens and computeBarCells calculate tools usage and bar segments", () => {
  const empty = estimateToolTokens([])
  expect(empty).toBe(0)

  const tokens = estimateToolTokens([
    {
      type: "assistant",
      content: [{ type: "tool", name: "memory", state: { input: { q: "test" }, output: "done" } }],
    },
  ])
  expect(tokens).toBeGreaterThan(0)

  const standardTokens = { input: 1000, cacheRead: 2000, cacheWrite: 0, output: 500, reasoning: 0 }
  const cells = computeBarCells(standardTokens, 10000, 30, 500)
  expect(cells.some((c) => c.kind.id === "tools")).toBe(true)
})

test("parseCompactionThreshold correctly parses threshold string formats", () => {
  // Empty & invalid
  expect(parseCompactionThreshold("")).toBeUndefined()
  expect(parseCompactionThreshold("invalid")).toBeUndefined()
  expect(parseCompactionThreshold("-10")).toBeUndefined()

  // 0 / all limit
  expect(parseCompactionThreshold("0")).toBe(0)
  expect(parseCompactionThreshold("all")).toBe(0)
  expect(parseCompactionThreshold("max")).toBe(0)
  expect(parseCompactionThreshold("весь")).toBe(0)
  expect(parseCompactionThreshold("весь лимит")).toBe(0)

  // k / K
  expect(parseCompactionThreshold("400k")).toBe(400000)
  expect(parseCompactionThreshold("400K")).toBe(400000)
  expect(parseCompactionThreshold("80k")).toBe(80000)
  expect(parseCompactionThreshold("1.5k")).toBe(1500)

  // m / M
  expect(parseCompactionThreshold("1m")).toBe(1000000)
  expect(parseCompactionThreshold("0.5M")).toBe(500000)

  // Raw numbers
  expect(parseCompactionThreshold("200000")).toBe(200000)
  expect(parseCompactionThreshold(" 200,000 ")).toBe(200000)
})

test("formatCompactionThreshold renders compact human-readable values", () => {
  expect(formatCompactionThreshold(0, true)).toBe("Весь лимит")
  expect(formatCompactionThreshold(0, false)).toBe("Context limit")
  expect(formatCompactionThreshold(400000, true)).toBe("400k")
  expect(formatCompactionThreshold(80000, false)).toBe("80k")
  expect(formatCompactionThreshold(1000000, false)).toBe("1m")
  expect(formatCompactionThreshold(1500000, false)).toBe("1.5m")
  expect(formatCompactionThreshold(500, true)).toBe("500")
})

test("extractServerCompactionThreshold extracts threshold from array or object server config", () => {
  expect(extractServerCompactionThreshold(undefined)).toBeUndefined()
  expect(extractServerCompactionThreshold(null)).toBeUndefined()
  expect(extractServerCompactionThreshold({})).toBeUndefined()
  expect(extractServerCompactionThreshold({ compaction: { threshold: 250000 } })).toBe(250000)

  const entries = [
    { type: "directory", path: "/tmp" },
    { type: "document", info: { compaction: { threshold: 400000 } } },
    { type: "document", info: { model: "default" } },
  ]
  expect(extractServerCompactionThreshold(entries)).toBe(400000)

  const emptyEntries = [
    { type: "directory", path: "/tmp" },
    { type: "document", info: { model: "default" } },
  ]
  expect(extractServerCompactionThreshold(emptyEntries)).toBeUndefined()
})

test("saveDirectFallback directly updates orchestra.jsonc and orchestra.json config files", async () => {
  const tmpDir = await mkdtemp(path.join(tmpdir(), "orchestra-cfg-"))
  const originalEnv = process.env.XDG_CONFIG_HOME
  process.env.XDG_CONFIG_HOME = tmpDir

  try {
    const orchestraDir = path.join(tmpDir, "orchestra")
    await mkdir(orchestraDir, { recursive: true })
    const configFile = path.join(orchestraDir, "orchestra.jsonc")
    await writeFile(configFile, "// Config comment\n" + JSON.stringify({ model: "test-model" }, null, 2), "utf-8")

    const updated = await saveDirectFallback(350000)
    expect(updated).toBe(true)

    const saved = JSON.parse(await readFile(configFile, "utf-8"))
    expect(saved.compaction?.threshold).toBe(350000)
  } finally {
    process.env.XDG_CONFIG_HOME = originalEnv
  }
})

test("the session scope renders Claude-style auto-compaction header and progress line", async () => {
  const { setup, frame } = await mount()
  try {
    const lines = await frame((text) => text.includes("Auto-compaction at:"))
    const text = lines.join("\n")
    expect(text).toContain("Context")
    expect(text).toContain("45% used")
    expect(text).toContain("Session")
    expect(text).toContain("Project")
    expect(text).toContain("Group")
    expect(text).toContain("Auto-compaction at:")
    expect(text).toContain("Context limit ✎")
    expect(text).toContain("45% of context limit")
    expect(text).toContain("Input")
    expect(text).toContain("Cache read")
    expect(text).toContain("Free space")

    const row = lines.findIndex((line) => line.includes("Project"))
    await setup.mockMouse.click(lines[row].indexOf("Project") + 1, row)
    const scoped = (
      await frame((value) => value.includes("does not belong") || value.includes("Loading") || value.includes("Could not"))
    ).join("\n")
    expect(scoped).not.toContain("Cache read")
    expect(scoped).not.toContain("Auto-compaction at:")
  } finally {
    setup.renderer.destroy()
  }
})

test("sidebar loads default compaction threshold from server config", async () => {
  const { setup, frame } = await mount({
    serverConfig: {
      compaction: { threshold: 400000 },
    },
  })
  try {
    const lines = await frame((text) => text.includes("400k ✎"))
    const text = lines.join("\n")
    expect(text).toContain("Auto-compaction at:")
    expect(text).toContain("400k ✎")
  } finally {
    setup.renderer.destroy()
  }
})

test("sidebar loads default compaction threshold from canonical server config entries array", async () => {
  const { setup, frame } = await mount({
    serverConfig: [
      { type: "directory", path: "/tmp" },
      { type: "document", info: { compaction: { threshold: 450000 } } },
    ],
  })
  try {
    const lines = await frame((text) => text.includes("450k ✎"))
    const text = lines.join("\n")
    expect(text).toContain("Auto-compaction at:")
    expect(text).toContain("450k ✎")
  } finally {
    setup.renderer.destroy()
  }
})

test("interactive prompt allows manual input of threshold and saving as default config via client.config.update", async () => {
  let promptShown = false
  let confirmShown = false

  const { setup, frame, getClientConfigUpdate, getClientSessionUpdate } = await mount({
    onPrompt: async (opts) => {
      promptShown = true
      expect(opts.title).toContain("compaction")
      return "250k"
    },
    onConfirm: async (opts) => {
      confirmShown = true
      expect(opts.message).toContain("default")
      return true
    },
  })

  try {
    const lines = await frame((text) => text.includes("Auto-compaction at:"))
    const row = lines.findIndex((l) => l.includes("Context limit ✎"))
    expect(row).toBeGreaterThanOrEqual(0)
    const col = lines[row].indexOf("Context limit ✎")

    await setup.mockMouse.click(col + 2, row)

    expect(promptShown).toBe(true)
    expect(confirmShown).toBe(true)

    // Проверяем вызов обновления метаданных сессии
    expect(getClientSessionUpdate()).toEqual({ sessionID: "ses_1", metadata: { compaction_threshold: 250000 } })

    // Проверяем вызов обновления через props.context.client.config.update
    expect(getClientConfigUpdate()).toEqual({ compaction: { threshold: 250000 } })

    // Проверяем, что сайдбар обновился и показывает 250k ✎
    const updatedLines = await frame((text) => text.includes("250k ✎"))
    expect(updatedLines.join("\n")).toContain("250k ✎")
  } finally {
    setup.renderer.destroy()
  }
})

test("interactive prompt allows setting 0 / no limit and updates session metadata", async () => {
  let promptShown = false
  const { setup, frame, getClientSessionUpdate } = await mount({
    onPrompt: async () => {
      promptShown = true
      return "0"
    },
    onConfirm: async () => false, // do not make default
  })

  try {
    const lines = await frame((text) => text.includes("Auto-compaction at:"))
    const row = lines.findIndex((l) => l.includes("Context limit ✎"))
    const col = lines[row].indexOf("Context limit ✎")
    await setup.mockMouse.click(col + 2, row)

    expect(promptShown).toBe(true)
    expect(getClientSessionUpdate()).toEqual({ sessionID: "ses_1", metadata: { compaction_threshold: 0 } })
  } finally {
    setup.renderer.destroy()
  }
})

test("sidebar context renders Russian localization for auto-compaction and progress when language is ru", async () => {
  const toolMessages = [
    {
      id: "msg_1",
      type: "assistant",
      model: { providerID: "p", id: "m" },
      tokens: { input: 1000, output: 200, reasoning: 0, cache: { read: 7000, write: 800 } },
      content: [
        {
          type: "tool",
          name: "context7",
          tokens: 400,
        },
      ],
    },
  ]

  const { setup, frame } = await mount({ messages: toolMessages, language: "ru" })
  try {
    const lines = await frame((text) => text.includes("Автосжатие при:"))
    const text = lines.join("\n")
    expect(text).toContain("Автосжатие при:")
    expect(text).toContain("Весь лимит ✎")
    expect(text).toContain("45% из 100% лимита контекста")
    expect(text).toContain("Инструменты и MCP")
  } finally {
    setup.renderer.destroy()
  }
})
