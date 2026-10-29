/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { onCleanup } from "solid-js"
import type { PluginInfo } from "@orchestra/client"
import type { Context, ToastOptions } from "@orchestra/plugin/tui/context"
import { ConfigProvider, type Interface as ConfigInterface } from "../../../src/config"
import { Keymap } from "../../../src/context/keymap"
import { ThemeProvider, useThemes } from "../../../src/context/theme"
// The plugin context registers every builtin, and the plugins dialog imports
// the context back, so the context must load first exactly as it does in the app.
import type { usePlugin } from "../../../src/plugin/context"
import "../../../src/plugin/context"
import { ClientProvider } from "../../../src/context/client"
import { DataProvider } from "../../../src/context/data"
import { LocationProvider } from "../../../src/context/location"
import { RouteProvider } from "../../../src/context/route"
import { PluginsDialog } from "../../../src/feature-plugins/system/plugins"
import { DialogProvider } from "../../../src/ui/dialog"
import { ToastProvider } from "../../../src/ui/toast"
import { emptyThemeSource, tmpdir } from "../../fixture/fixture"
import { createApi, createFetch, json } from "../../fixture/tui-client"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"

const target = "git+ssh://git@github.com/example/team-plugins.git"

function packagePlugin(outdated: boolean): PluginInfo {
  return {
    id: "team.plugins",
    source: { type: "package", target, version: "dadba13", ...(outdated ? { outdated: true as const } : {}) },
    features: { server: true },
    state: { status: "active" },
  }
}

async function renderPlugins(
  root: string,
  inventory: { list: PluginInfo[]; check: PluginInfo[] },
  tui?: {
    registered: { id: string; source: "builtin" | "external"; active: boolean }[]
    list: { target: string; id?: string; status: "active" | "inactive" | "failed"; error?: string }[]
  },
  // The plugins the TUI config declares, and what the install prompt answers.
  config?: { declared?: string[]; prompt?: string },
) {
  const state = path.join(root, "state")
  await mkdir(state, { recursive: true })
  const requests: { path: string; body: unknown }[] = []
  const toasts: ToastOptions[] = []
  const activations: string[] = []
  // Declared plugins as the config file holds them; every write replaces this list.
  const saved = { plugins: config?.declared ?? [] }
  let reopened = 0
  const configService = {
    get: async () => ({ plugins: saved.plugins }),
    update: async (change: (draft: { plugins: string[] }) => void) => {
      const draft = { plugins: [...saved.plugins] }
      change(draft)
      saved.plugins = draft.plugins
      return { plugins: saved.plugins }
    },
  }
  const location = { directory: root, project: { id: "proj_test", directory: root, canonical: root } }
  const transport = createFetch(async (url, request) => {
    if (url.pathname === "/api/plugin") return json({ location, data: inventory.list })
    if (url.pathname === "/api/plugin/check") {
      requests.push({ path: url.pathname, body: await request.json() })
      return json({ location, data: inventory.check })
    }
    if (url.pathname === "/api/plugin/update") {
      requests.push({ path: url.pathname, body: await request.json() })
      return new Response(null, { status: 204 })
    }
  })
  const api = createApi(transport.fetch)

  function Harness() {
    function Content() {
      onCleanup(Keymap.use().mode.push("modal"))
      const theme = useThemes().currentTokens()
      const context = {
        client: api,
        data: { location: { default: () => ({ directory: root }) }, on: () => () => {} },
        get theme() {
          return theme
        },
        ui: {
          toast: { show: (toast: ToastOptions) => toasts.push(toast) },
          format: { path: (value: string) => value },
          dialog: { prompt: async () => config?.prompt, show: () => void reopened++ },
        },
      } as unknown as Context
      const plugins = {
        registered: () => tui?.registered ?? [],
        list: () => tui?.list ?? [],
        activate: async (id: string) => {
          activations.push(id)
          return true
        },
        deactivate: async () => true,
      } as unknown as ReturnType<typeof usePlugin>
      return <PluginsDialog context={context} plugins={plugins} />
    }

    return (
      <TestTuiContexts directory={root} paths={{ home: root, state, worktree: root }}>
        <ConfigProvider
          config={createTuiResolvedConfig({ plugins: config?.declared })}
          service={configService as unknown as ConfigInterface}
        >
          <RouteProvider initialRoute={{ type: "home" }}>
            <ClientProvider api={api}>
              <DataProvider directory={root}>
                <LocationProvider>
                  <Keymap.Provider>
                    <ThemeProvider mode="dark" source={emptyThemeSource}>
                      <ToastProvider>
                        <DialogProvider>
                          <Content />
                        </DialogProvider>
                      </ToastProvider>
                    </ThemeProvider>
                  </Keymap.Provider>
                </LocationProvider>
              </DataProvider>
            </ClientProvider>
          </RouteProvider>
        </ConfigProvider>
      </TestTuiContexts>
    )
  }

  const app = await testRender(() => <Harness />, { width: 80, height: 20, kittyKeyboard: true })
  app.renderer.start()
  const expected = tui?.list[0]?.id ?? inventory.list[0]?.id ?? "local.plugin"
  await app.waitForFrame((frame) => frame.includes(expected))
  return { app, requests, toasts, activations, saved, reopened: () => reopened }
}

test("failed TUI plugins keep enter to enable and use space to show the error", async () => {
  await using tmp = await tmpdir()
  const fixture = await renderPlugins(
    tmp.path,
    { list: [], check: [] },
    {
      registered: [{ id: "broken.plugin", source: "external", active: false }],
      list: [
        {
          target: "./broken.ts",
          id: "broken.plugin",
          status: "failed",
          error: "Plugin setup failed",
        },
      ],
    },
  )

  try {
    await fixture.app.waitForFrame((frame) => frame.includes("broken.plugin") && frame.includes("view error"))
    expect(fixture.app.captureCharFrame()).toContain("enable")

    fixture.app.mockInput.pressEnter()
    await fixture.app.waitFor(() => fixture.activations.length === 1)
    expect(fixture.activations).toEqual(["broken.plugin"])

    fixture.app.mockInput.pressKey(" ")
    await fixture.app.waitForFrame(
      (frame) => frame.includes("TUI plugin error") && frame.includes("Plugin setup failed"),
    )
  } finally {
    fixture.app.renderer.destroy()
  }
})

test("checking for updates refreshes the inventory and reveals the update action", async () => {
  await using tmp = await tmpdir()
  const fixture = await renderPlugins(tmp.path, { list: [packagePlugin(false)], check: [packagePlugin(true)] })

  try {
    // The update action starts hidden: triggering it before a check issues no request.
    fixture.app.mockInput.pressKey("u", { ctrl: true })
    await fixture.app.flush()
    expect(fixture.requests).toEqual([])

    fixture.app.mockInput.pressKey("r", { ctrl: true })
    await fixture.app.waitFor(() => fixture.requests.length === 1)
    expect(fixture.requests).toEqual([{ path: "/api/plugin/check", body: {} }])
    // Let the check response apply before triggering the now-enabled update.
    await fixture.app.flush()

    fixture.app.mockInput.pressKey("u", { ctrl: true })
    await fixture.app.waitFor(() => fixture.requests.length === 2)
    expect(fixture.requests[1]).toEqual({ path: "/api/plugin/update", body: { targets: [target] } })
  } finally {
    fixture.app.renderer.destroy()
  }
})

test("checking for updates reports an up-to-date inventory", async () => {
  await using tmp = await tmpdir()
  const fixture = await renderPlugins(tmp.path, { list: [packagePlugin(false)], check: [packagePlugin(false)] })

  try {
    fixture.app.mockInput.pressKey("r", { ctrl: true })
    await fixture.app.waitFor(() => fixture.requests.length === 1)
    await fixture.app.flush()

    expect(fixture.requests).toEqual([{ path: "/api/plugin/check", body: {} }])
    expect(fixture.toasts).toEqual([])
  } finally {
    fixture.app.renderer.destroy()
  }
})

test("the check action stays hidden without package plugins", async () => {
  await using tmp = await tmpdir()
  const local: PluginInfo = {
    id: "local.plugin",
    source: { type: "local", path: path.join(tmp.path, "plugin.ts") },
    features: { server: true },
    state: { status: "active" },
  }
  const fixture = await renderPlugins(tmp.path, { list: [local], check: [] })

  try {
    fixture.app.mockInput.pressKey("r", { ctrl: true })
    await fixture.app.flush()
    expect(fixture.requests).toEqual([])
  } finally {
    fixture.app.renderer.destroy()
  }
})

const external = "github:NeiP4n/orchestra-plugin-stats"

test("ctrl+d removes an external plugin from the TUI config", async () => {
  await using tmp = await tmpdir()
  const fixture = await renderPlugins(
    tmp.path,
    { list: [], check: [] },
    {
      registered: [{ id: "stats.plugin", source: "external", active: true }],
      list: [{ target: external, id: "stats.plugin", status: "active" }],
    },
    { declared: [external, "./other.ts"] },
  )

  try {
    fixture.app.mockInput.pressKey("d", { ctrl: true })
    await fixture.app.waitFor(() => fixture.saved.plugins.length === 1)
    expect(fixture.saved.plugins).toEqual(["./other.ts"])
    expect(fixture.toasts.at(-1)).toMatchObject({ variant: "success", message: `Removed ${external}` })
  } finally {
    fixture.app.renderer.destroy()
  }
})

test("ctrl+d turns a built-in plugin off for good and restores it the second time", async () => {
  await using tmp = await tmpdir()
  const fixture = await renderPlugins(
    tmp.path,
    { list: [], check: [] },
    { registered: [{ id: "opencode.mascot", source: "builtin", active: true }], list: [{ target: "x", id: "opencode.mascot", status: "active" }] },
  )

  try {
    // Built-ins are hidden until internal plugins are shown.
    fixture.app.mockInput.pressKey("a", { ctrl: true })
    await fixture.app.waitForFrame((frame) => frame.includes("opencode.mascot"))

    fixture.app.mockInput.pressKey("d", { ctrl: true })
    await fixture.app.waitFor(() => fixture.saved.plugins.length === 1)
    expect(fixture.saved.plugins).toEqual(["-opencode.mascot"])

    fixture.app.mockInput.pressKey("d", { ctrl: true })
    await fixture.app.waitFor(() => fixture.saved.plugins.length === 0)
    expect(fixture.toasts.at(-1)).toMatchObject({ variant: "success", message: "opencode.mascot restored" })
  } finally {
    fixture.app.renderer.destroy()
  }
})

test("ctrl+d on a server plugin explains the CLI command instead of editing the config", async () => {
  await using tmp = await tmpdir()
  const fixture = await renderPlugins(tmp.path, { list: [packagePlugin(false)], check: [] })

  try {
    fixture.app.mockInput.pressKey("d", { ctrl: true })
    await fixture.app.waitFor(() => fixture.toasts.length === 1)
    expect(fixture.toasts[0]?.message).toContain(`orchestra plugin remove ${target}`)
    expect(fixture.saved.plugins).toEqual([])
  } finally {
    fixture.app.renderer.destroy()
  }
})

test("ctrl+n installs a GitHub shorthand into the TUI config and reopens the list", async () => {
  await using tmp = await tmpdir()
  const fixture = await renderPlugins(tmp.path, { list: [packagePlugin(false)], check: [] }, undefined, {
    prompt: "NeiP4n/orchestra-plugin-stats",
  })

  try {
    fixture.app.mockInput.pressKey("n", { ctrl: true })
    await fixture.app.waitFor(() => fixture.reopened() === 1)
    expect(fixture.saved.plugins).toEqual([external])
    expect(fixture.toasts.at(-1)).toMatchObject({ variant: "success", message: `Installing ${external}…` })
  } finally {
    fixture.app.renderer.destroy()
  }
})

test("ctrl+n ignores a cancelled prompt and an already installed plugin", async () => {
  await using tmp = await tmpdir()
  const cancelled = await renderPlugins(tmp.path, { list: [packagePlugin(false)], check: [] })
  try {
    cancelled.app.mockInput.pressKey("n", { ctrl: true })
    await cancelled.app.waitFor(() => cancelled.reopened() === 1)
    expect(cancelled.saved.plugins).toEqual([])
  } finally {
    cancelled.app.renderer.destroy()
  }

  const again = await renderPlugins(tmp.path, { list: [packagePlugin(false)], check: [] }, undefined, {
    declared: [external],
    prompt: external,
  })
  try {
    again.app.mockInput.pressKey("n", { ctrl: true })
    await again.app.waitFor(() => again.reopened() === 1)
    expect(again.saved.plugins).toEqual([external])
    expect(again.toasts.at(-1)).toMatchObject({ variant: "info", message: `${external} is already installed` })
  } finally {
    again.app.renderer.destroy()
  }
})
