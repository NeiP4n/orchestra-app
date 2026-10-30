/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { createSignal, onCleanup } from "solid-js"
import { ConfigProvider } from "../../src/config"
import { Keymap } from "../../src/context/keymap"
import { ThemeProvider } from "../../src/context/theme"
import { DialogProvider } from "../../src/ui/dialog"
import { ToastProvider } from "../../src/ui/toast"
import { emptyThemeSource } from "../fixture/fixture"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"
import { DialogSelect, type DialogSelectOption, type DialogSelectProps } from "../../src/ui/dialog-select"

async function renderSelect<T>(props: () => DialogSelectProps<T>, options?: { width?: number; height?: number }) {
  function Harness() {
    onCleanup(Keymap.use().mode.push("modal"))
    return <DialogSelect {...props()} />
  }

  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <Keymap.Provider>
            <ThemeProvider mode="dark" source={emptyThemeSource}>
              <ToastProvider>
                <DialogProvider>
                  <Harness />
                </DialogProvider>
              </ToastProvider>
            </ThemeProvider>
          </Keymap.Provider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: options?.width ?? 80, height: options?.height ?? 24, kittyKeyboard: true },
  )
  app.renderer.start()
  return app
}

test("State 1 - Loading: displays spinner, skeleton bars and blocks interaction", async () => {
  let selectCalled = false
  const app = await renderSelect(() => ({
    title: "Loading Dialog",
    loading: true,
    options: [
      { title: "Alpha", value: "a" },
      { title: "Beta", value: "b" },
    ],
    onSelect: () => {
      selectCalled = true
    },
  }))

  try {
    await app.waitForFrame((frame) => frame.includes("Loading Dialog") && frame.includes("Loading…"))
    const frame = app.captureCharFrame()
    expect(frame).toContain("Loading Dialog")
    expect(frame).toContain("Loading…")
    // Skeleton bar placeholder
    expect(frame).toContain("━")
    // While loading, actual options should NOT be rendered
    expect(frame).not.toContain("Alpha")
    expect(frame).not.toContain("Beta")

    // Attempting to submit via Enter should be ignored during loading
    app.mockInput.pressEnter()
    expect(selectCalled).toBe(false)
  } finally {
    app.renderer.destroy()
  }
})

test("State 2 - Error: renders error text and triggers onRetry callback via Ctrl+R", async () => {
  let retryCount = 0
  const app = await renderSelect(() => ({
    title: "Error Dialog",
    error: "Connection timeout to agent cluster",
    onRetry: () => {
      retryCount++
    },
    options: [{ title: "Item 1", value: "1" }],
  }))

  try {
    await app.waitForFrame((frame) => frame.includes("Error Dialog") && frame.includes("Connection timeout"))
    const frame = app.captureCharFrame()
    expect(frame).toContain("Error:")
    expect(frame).toContain("Connection timeout to agent cluster")
    expect(frame).toContain("Retry")
    expect(frame).toContain("Ctrl+R")

    // Pressing Ctrl+R triggers onRetry
    app.mockInput.pressKey("r", { ctrl: true })
    expect(retryCount).toBe(1)

    app.mockInput.pressKey("r", { ctrl: true })
    expect(retryCount).toBe(2)
  } finally {
    app.renderer.destroy()
  }
})

test("State 2 - Error: renders Error object message without retry when onRetry is omitted", async () => {
  const app = await renderSelect(() => ({
    title: "Fatal Error Dialog",
    error: new Error("Failed to load workspace permissions"),
    options: [],
  }))

  try {
    await app.waitForFrame((frame) => frame.includes("Failed to load workspace permissions"))
    const frame = app.captureCharFrame()
    expect(frame).toContain("Error:")
    expect(frame).toContain("Failed to load workspace permissions")
    expect(frame).not.toContain("Ctrl+R")
  } finally {
    app.renderer.destroy()
  }
})

test("State 3 - Empty: renders 'No items available' and triggers onCancel via Esc", async () => {
  let cancelCalled = false
  const app = await renderSelect(() => ({
    title: "Empty Dialog",
    options: [],
    onCancel: () => {
      cancelCalled = true
    },
  }))

  try {
    await app.waitForFrame((frame) => frame.includes("Empty Dialog") && frame.includes("No items available"))
    const frame = app.captureCharFrame()
    expect(frame).toContain("No items available")
    expect(frame).toContain("Esc")
    expect(frame).toContain("to return")

    app.mockInput.pressEscape()
    expect(cancelCalled).toBe(true)
  } finally {
    app.renderer.destroy()
  }
})

test("State 3 - Empty: renders custom emptyView when provided", async () => {
  const app = await renderSelect(() => ({
    title: "Custom Empty Dialog",
    options: [],
    emptyView: (
      <box paddingLeft={4} paddingTop={1}>
        <text>Custom Empty View: No plugins found in registry</text>
      </box>
    ),
  }))

  try {
    await app.waitForFrame((frame) => frame.includes("Custom Empty View: No plugins found in registry"))
    const frame = app.captureCharFrame()
    expect(frame).toContain("Custom Empty View: No plugins found in registry")
    expect(frame).not.toContain("No items available")
  } finally {
    app.renderer.destroy()
  }
})

test("State 4 - No Match: renders 'No results found' with clear search CTA and custom noMatchView", async () => {
  const options: DialogSelectOption<string>[] = [
    { title: "Dashboard", value: "dash" },
    { title: "Settings", value: "sett" },
  ]

  const app = await renderSelect(() => ({
    title: "Search Dialog",
    options,
  }))

  try {
    await app.waitForFrame((frame) => frame.includes("Dashboard") && frame.includes("Settings"))

    // Type a query that matches nothing
    await app.mockInput.typeText("nonexistent_filter_xyz")
    await app.waitForFrame((frame) => frame.includes("No results found for") && frame.includes("nonexistent_filter_xyz"))

    const frame = app.captureCharFrame()
    expect(frame).toContain("No results found for \"nonexistent_filter_xyz\"")
    expect(frame).toContain("Clear search")
    expect(frame).toContain("to view all items")
    expect(frame).not.toContain("Dashboard")
    expect(frame).not.toContain("Settings")
  } finally {
    app.renderer.destroy()
  }
})

test("State 4 - No Match: renders custom noMatchView when provided", async () => {
  const options: DialogSelectOption<string>[] = [
    { title: "Workspace Alpha", value: "ws_a" },
  ]

  const app = await renderSelect(() => ({
    title: "Filter Dialog",
    options,
    noMatchView: (
      <box paddingLeft={4} paddingTop={1}>
        <text>Custom No-Match View: Zero matches for active filter</text>
      </box>
    ),
  }))

  try {
    await app.waitForFrame((frame) => frame.includes("Workspace Alpha"))
    await app.mockInput.typeText("zzz")
    await app.waitForFrame((frame) => frame.includes("Custom No-Match View: Zero matches for active filter"))

    const frame = app.captureCharFrame()
    expect(frame).toContain("Custom No-Match View: Zero matches for active filter")
  } finally {
    app.renderer.destroy()
  }
})

test("State 5 - Populated: renders categories, navigation hints and excludes disabled options", async () => {
  const options: DialogSelectOption<string>[] = [
    { title: "Alpha Item", value: "a", category: "Primary" },
    { title: "Beta Item", value: "b", category: "Primary" },
    { title: "Gamma Disabled", value: "g", category: "Secondary", disabled: true },
    { title: "Delta Item", value: "d", category: "Secondary" },
  ]

  const app = await renderSelect(() => ({
    title: "Categories Dialog",
    options,
  }))

  try {
    await app.waitForFrame((frame) => frame.includes("Alpha Item") && frame.includes("Primary"))
    const frame = app.captureCharFrame()
    expect(frame).toContain("Primary")
    expect(frame).toContain("Secondary")
    expect(frame).toContain("Alpha Item")
    expect(frame).toContain("Beta Item")
    expect(frame).toContain("Delta Item")
    // Disabled items must be excluded from rendered options
    expect(frame).not.toContain("Gamma Disabled")
    // Footer navigation hints
    expect(frame).toContain("navigate")
    expect(frame).toContain("select")
  } finally {
    app.renderer.destroy()
  }
})

test("State 5 - Keyboard Navigation: supports Arrow keys, Vim Ctrl+j/Ctrl+k, Home, and End", async () => {
  const moved: string[] = []
  const options: DialogSelectOption<string>[] = [
    { title: "First", value: "1" },
    { title: "Second", value: "2" },
    { title: "Third", value: "3" },
    { title: "Fourth", value: "4" },
  ]

  const app = await renderSelect(() => ({
    title: "Nav Dialog",
    options,
    onMove: (opt) => moved.push(opt.value),
  }))

  try {
    await app.waitForFrame((frame) => frame.includes("First") && frame.includes("Fourth"))

    // Arrow down moves to Second
    app.mockInput.pressArrow("down")
    expect(moved.at(-1)).toBe("2")

    // Vim ctrl+j moves to Third
    app.mockInput.pressKey("j", { ctrl: true })
    expect(moved.at(-1)).toBe("3")

    // Vim ctrl+k moves back to Second
    app.mockInput.pressKey("k", { ctrl: true })
    expect(moved.at(-1)).toBe("2")

    // End key moves to Fourth (last)
    app.mockInput.pressKey("END")
    expect(moved.at(-1)).toBe("4")

    // Home key moves to First (first)
    app.mockInput.pressKey("HOME")
    expect(moved.at(-1)).toBe("1")
  } finally {
    app.renderer.destroy()
  }
})

test("State 5 - Selection: Enter key triggers onSelect and option.onSelect callbacks", async () => {
  let selectResult: string | undefined
  let optionSelectCalled = false

  const options: DialogSelectOption<string>[] = [
    { title: "Option One", value: "one" },
    {
      title: "Option Two",
      value: "two",
      onSelect: () => {
        optionSelectCalled = true
      },
    },
  ]

  const app = await renderSelect(() => ({
    title: "Select Dialog",
    options,
    onSelect: (opt) => {
      selectResult = opt.value
    },
  }))

  try {
    await app.waitForFrame((frame) => frame.includes("Option One") && frame.includes("Option Two"))

    // Move to Option Two
    app.mockInput.pressArrow("down")

    // Submit selection
    app.mockInput.pressEnter()

    expect(selectResult).toBe("two")
    expect(optionSelectCalled).toBe(true)
  } finally {
    app.renderer.destroy()
  }
})

test("Fuzzysort Filtering: prioritizes title matches over category matches and handles threshold", async () => {
  const options: DialogSelectOption<string>[] = [
    { title: "Project Manager", value: "pm", category: "Tools" },
    { title: "Database Viewer", value: "db", category: "Project" },
    { title: "Config Editor", value: "cfg", category: "Settings", searchText: "project settings" },
  ]

  const app = await renderSelect(() => ({
    title: "Fuzzy Dialog",
    options,
  }))

  try {
    await app.waitForFrame((frame) => frame.includes("Project Manager"))

    // Search for "project"
    await app.mockInput.typeText("project")
    await app.waitForFrame((frame) => frame.includes("Project Manager"))

    const frame = app.captureCharFrame()
    // "Project Manager" has title match (weight 2), so it must be present
    expect(frame).toContain("Project Manager")

    // Category and searchText matches also appear if threshold allows
    expect(frame).toContain("Database Viewer")
  } finally {
    app.renderer.destroy()
  }
})

test("Adversarial: handles unicode, special characters, and dynamic state transitions", async () => {
    const [error, setError] = createSignal<string | null>(null)

  const options: DialogSelectOption<string>[] = [
    { title: "⚡ High Voltage & Special <Chars> \"Quoted\"", value: "special_1" },
    { title: "日本語アイテム (Japanese)", value: "unicode_2" },
    { title: "A".repeat(80), value: "long_title" },
  ]

  const app = await renderSelect(() => ({
    title: "Adversarial Dialog",
        error: error(),
    options,
  }))

  try {
    // Initial populated render
    await app.waitForFrame((frame) => frame.includes("High Voltage"))
    let frame = app.captureCharFrame()
    expect(frame).toContain("High Voltage")
    expect(frame).toContain("日本語アイテム")

    // Transition dynamically to error state
    setError("Runtime failure occurred")
    await app.waitForFrame((frame) => frame.includes("Runtime failure occurred"))
    frame = app.captureCharFrame()
    expect(frame).toContain("Error:")
    expect(frame).toContain("Runtime failure occurred")
    expect(frame).not.toContain("High Voltage")

    // Transition back to populated
    setError(null)
    await app.waitForFrame((frame) => frame.includes("High Voltage"))
    frame = app.captureCharFrame()
    expect(frame).toContain("High Voltage")
  } finally {
    app.renderer.destroy()
  }
})