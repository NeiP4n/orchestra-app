/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { onMount } from "solid-js"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { emptyThemeSource } from "../../fixture/fixture"
import { ConfigProvider, type Info, type Interface } from "../../../src/config"
import { ThemeProvider, useThemes } from "../../../src/context/theme"
import { DialogThemeList } from "../../../src/component/dialog-theme-list"
import { Keymap } from "../../../src/context/keymap"
import { DialogProvider, useDialog } from "../../../src/ui/dialog"
import { ToastProvider } from "../../../src/ui/toast"
import { TestTuiContexts } from "../../fixture/tui-environment"

async function wait(fn: () => boolean) {
  const started = Date.now()
  while (!fn()) {
    if (Date.now() - started > 3000) throw new Error("timed out waiting for theme state")
    await Bun.sleep(10)
  }
}

function fakeService(initial: Info, opts?: { fail?: boolean; delay?: number }) {
  let current = structuredClone(initial)
  const writes: (string | undefined)[] = []
  const service: Interface = {
    get: async () => current,
    update: async (update) => {
      if (opts?.fail) throw new Error("disk is full")
      if (opts?.delay) await Bun.sleep(opts.delay)
      const draft = structuredClone(current)
      update(draft)
      current = draft
      writes.push(draft.theme?.name)
      return current
    },
  }
  return { service, stored: () => current, writes }
}

function probe() {
  let themes: ReturnType<typeof useThemes> | undefined
  function Probe() {
    themes = useThemes()
    return null
  }
  return {
    Probe,
    ready: () => themes?.ready === true,
    current() {
      if (!themes) throw new Error("Theme provider is not mounted")
      return themes
    },
  }
}

async function renderThemes(initial: Info, fake: ReturnType<typeof fakeService>) {
  const { Probe, current, ready } = probe()
  const app = await testRender(
    () => (
      <ConfigProvider config={createTuiResolvedConfig(initial)} service={fake.service}>
        <ThemeProvider mode="dark" source={emptyThemeSource}>
          <Probe />
        </ThemeProvider>
      </ConfigProvider>
    ),
    { width: 20, height: 2 },
  )
  app.renderer.start()
  await wait(ready)
  return { app, current }
}

test("preview switches the visible theme without persisting it", async () => {
  const fake = fakeService({ theme: { name: "orchestra" } })
  const { app, current } = await renderThemes({ theme: { name: "orchestra" } }, fake)
  try {
    expect(current().preview("sculk")).toBe(true)
    expect(current().selected).toBe("sculk")
    expect(fake.writes).toEqual([])
    expect(fake.stored().theme?.name).toBe("orchestra")
    expect(current().preview("missing-theme")).toBe(false)
  } finally {
    app.renderer.destroy()
  }
})

test("commit persists the confirmed theme before resolving", async () => {
  const fake = fakeService({ theme: { name: "orchestra" } })
  const { app, current } = await renderThemes({ theme: { name: "orchestra" } }, fake)
  try {
    await expect(current().commit("sculk")).resolves.toBe(true)
    expect(fake.stored().theme?.name).toBe("sculk")
    expect(current().selected).toBe("sculk")
    await expect(current().commit("missing-theme")).resolves.toBe(false)
  } finally {
    app.renderer.destroy()
  }
})

test("rapid commits are serialized: the last selection is the final stored value", async () => {
  const fake = fakeService({ theme: { name: "orchestra" } }, { delay: 15 })
  const { app, current } = await renderThemes({ theme: { name: "orchestra" } }, fake)
  try {
    const first = current().commit("nord")
    const second = current().commit("dracula")
    await Promise.all([first, second])
    expect(fake.writes).toEqual(["nord", "dracula"])
    expect(fake.stored().theme?.name).toBe("dracula")
  } finally {
    app.renderer.destroy()
  }
})

test("commit rejects when the config write fails instead of swallowing it", async () => {
  const fake = fakeService({ theme: { name: "orchestra" } }, { fail: true })
  const { app, current } = await renderThemes({ theme: { name: "orchestra" } }, fake)
  try {
    await expect(current().commit("sculk")).rejects.toThrow("disk is full")
    expect(fake.stored().theme?.name).toBe("orchestra")
  } finally {
    app.renderer.destroy()
  }
})

test("a stored legacy opencode selection migrates to orchestra and the migration is persisted", async () => {
  const fake = fakeService({ theme: { name: "opencode" } })
  const { app, current } = await renderThemes({ theme: { name: "opencode" } }, fake)
  try {
    await wait(() => fake.stored().theme?.name === "orchestra")
    expect(current().selected).toBe("orchestra")
  } finally {
    app.renderer.destroy()
  }
})

test("theme dialog: preview and cancel never write; select commits exactly once", async () => {
  const fake = fakeService({ theme: { name: "orchestra" } })
  const { Probe, current, ready } = probe()
  let dialog: ReturnType<typeof useDialog> | undefined

  function Fixture() {
    dialog = useDialog()
    onMount(() => dialog?.replace(() => <DialogThemeList />))
    return null
  }

  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={createTuiResolvedConfig({ theme: { name: "orchestra" } })} service={fake.service}>
          <Keymap.Provider>
            <ThemeProvider mode="dark" source={emptyThemeSource}>
              <ToastProvider>
                <DialogProvider>
                  <Probe />
                  <Fixture />
                </DialogProvider>
              </ToastProvider>
            </ThemeProvider>
          </Keymap.Provider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 80, height: 24, kittyKeyboard: true },
  )
  app.renderer.start()

  try {
    await wait(ready)
    await app.waitForFrame((frame) => frame.includes("Themes"))

    // Preview: moving the selection changes the visible theme only.
    app.mockInput.pressArrow("down")
    await wait(() => current().selected !== "orchestra")
    const previewed = current().selected
    expect(fake.writes).toEqual([])

    // Cancel: the original theme is restored in memory, still without a write.
    app.mockInput.pressEscape()
    await wait(() => current().selected === "orchestra")
    expect(fake.writes).toEqual([])
    expect(fake.stored().theme?.name).toBe("orchestra")

    // Reopen and confirm the same previewed theme: exactly one persisted write.
    dialog?.replace(() => <DialogThemeList />)
    await app.waitForFrame((frame) => frame.includes("Themes"))
    app.mockInput.pressArrow("down")
    await wait(() => current().selected === previewed)
    app.mockInput.pressEnter()
    await wait(() => fake.stored().theme?.name === previewed)
    expect(fake.writes).toEqual([previewed])
    expect(current().selected).toBe(previewed)
  } finally {
    app.renderer.destroy()
  }
})
