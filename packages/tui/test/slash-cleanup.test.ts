import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
const text = (file: string) => readFile(new URL(file, import.meta.url), "utf8")
test("removed slash commands have no registrations, palette IDs, aliases or dead keybinds", async () => {
  const app = await text("../src/app.tsx")
  for (const id of ["model.default", "docs.open", "app.layout.mobile", "app.toggle.state-effects"])
    expect(app).not.toContain(`name: "${id}"`)
  for (const name of ["default-model", "default", "docs", "mobile", "phone", "state-effects"])
    expect(app).not.toContain(`name: "${name}"`)
  for (const file of ["../src/config/keybind.ts", "../src/config/v1/keybind.ts"])
    expect(await text(file)).not.toContain("docs.open")
  const freebuff = await text("../src/feature-plugins/system/freebuff.tsx")
  expect(freebuff.match(/slash: \{ name: "freebuff" \}/g)).toHaveLength(1)
  for (const id of ["accounts", "add", "use"]) expect(freebuff).not.toContain(`id: "freebuff.${id}"`)
  // All account operations remain reachable inside the single status dialog.
  for (const callback of ["onAccounts=", "onAdd=", "onRefresh="]) expect(freebuff).toContain(callback)
  expect(freebuff).toContain('request<{ ok: boolean }>("use", { id: selected })')
})

test("/auth opens the existing integrations dialog in the actual app", async () => {
  const { createAppFixture } = await import("./fixture/app")
  await using setup = await createAppFixture({ config: { animations: false, language: "en" } })
  await setup.ready
  const { TextareaRenderable } = await import("@opentui/core")
  await setup.waitFor(() => setup.renderer.currentFocusedEditor instanceof TextareaRenderable)
  await Bun.sleep(100)
  await setup.renderOnce()
  await setup.mockInput.typeText("/auth")
  await setup.waitForFrame((frame) => frame.includes("/auth") && frame.includes("Connect provider"))
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => frame.includes("Connect an integration"))
  if (process.env.ORCHESTRA_CAPTURE_SCHEDULES)
    await Bun.write("/downloads/auth-dialog.spans.json", JSON.stringify(setup.captureSpans()))
  expect(setup.captureCharFrame()).toContain("Connect an integration")
})
