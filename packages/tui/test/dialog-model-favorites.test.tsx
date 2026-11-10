/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { DialogHelp } from "../src/ui/dialog-help"
import { DialogModel } from "../src/component/dialog-model"
import { model, renderLocal } from "./fixture/local"
import { directory, json } from "./fixture/tui-client"

// Favorites live in the server config: the picker reads them when it opens and writes the
// whole list back on every toggle, so every client of the same server lists the same models.
function serverConfig(favorites: string[], onUpdate?: (favorites: string[]) => void) {
  const stored = [...favorites]
  return async (url: URL, request: Request) => {
    if (url.pathname === "/api/experimental/config" && request.method === "PATCH") {
      const body = (await request.json()) as { model_favorites: string[] }
      stored.splice(0, stored.length, ...body.model_favorites)
      onUpdate?.(body.model_favorites)
      return new Response(null, { status: 204 })
    }
    if (url.pathname === "/api/config") return json([{ type: "document", info: { model_favorites: [...stored] } }])
    // The picker offers favorites only while a provider is connected, exactly like the app.
    if (url.pathname === "/api/integration")
      return json({
        location: { directory },
        data: [
          {
            id: "openai",
            name: "OpenAI",
            methods: [{ id: "key", type: "key" }],
            connections: [{ type: "env", name: "OPENAI_API_KEY" }],
          },
        ],
      })
  }
}

test("the picker opens on the Feature section with the favorites from the server config", async () => {
  await using setup = await renderLocal({
    models: [model("alpha"), model("beta")],
    fetch: serverConfig(["provider/beta"]),
  })
  await setup.data.location.config.sync()
  setup.dialog.replace(() => <DialogModel />)

  const frame = await setup.waitForFrame((frame) => frame.includes("Feature") && frame.includes("beta"))
  expect(frame.indexOf("Feature")).toBeGreaterThanOrEqual(0)
  expect(frame.indexOf("Feature")).toBeLessThan(frame.indexOf("beta"))
  // The pinned model leads the unpinned one, which stays in its provider section below.
  expect(frame.indexOf("beta")).toBeLessThan(frame.indexOf("alpha"))
})

test("toggling a favorite drops it from the Feature section and writes the rest to the config", async () => {
  const updates: string[][] = []
  await using setup = await renderLocal({
    models: [model("alpha"), model("beta")],
    fetch: serverConfig(["provider/beta"], (favorites) => updates.push(favorites)),
  })
  await setup.data.location.config.sync()
  setup.dialog.replace(() => <DialogModel />)
  await setup.waitForFrame((frame) => frame.includes("Feature") && frame.includes("beta"))

  setup.mockInput.pressKey("f", { ctrl: true })

  await setup.waitFor(() => updates.length === 1)
  expect(updates).toEqual([[]])
  const frame = await setup.waitForFrame((frame) => !frame.includes("Feature"))
  expect(frame).toContain("beta")
})

test("the model picker can save the selected default without a separate slash command", async () => {
  const updates: unknown[] = []
  const base = serverConfig([])
  await using setup = await renderLocal({
    models: [model("alpha")],
    fetch: async (url, request) => {
      if (url.pathname === "/api/experimental/config" && request.method === "PATCH") {
        updates.push(await request.json())
        return new Response(null, { status: 204 })
      }
      return base(url, request)
    },
  })
  setup.dialog.replace(() => <DialogModel />)
  await setup.waitForFrame((frame) => frame.includes("alpha") && frame.includes("По умолчанию"))
  if (process.env.ORCHESTRA_CAPTURE_SCHEDULES)
    await Bun.write("/downloads/model-default.spans.json", JSON.stringify(setup.captureSpans()))
  setup.mockInput.pressKey("d", { ctrl: true })
  await setup.waitFor(() => updates.length === 1)
  expect(updates).toEqual([{ model: "provider/alpha" }])
  expect(setup.renderer.isDestroyed).toBe(false)
})

test("help keeps the README link after the docs command is removed", async () => {
  await using setup = await renderLocal({ models: [model("alpha")], fetch: serverConfig([]) })
  setup.dialog.replace(() => <DialogHelp />)
  await setup.waitForFrame((frame) => frame.includes("Documentation (README)"))
  if (process.env.ORCHESTRA_CAPTURE_SCHEDULES)
    await Bun.write("/downloads/help-docs.spans.json", JSON.stringify(setup.captureSpans()))
  expect(setup.captureCharFrame()).toContain("Documentation (README)")
})

test("filtered model row remains selected and Enter applies it", async () => {
  await using setup = await renderLocal({ models: [model("alpha"), model("beta")], fetch: serverConfig([]) })
  setup.local.model.set({ providerID: "provider", modelID: "alpha" })
  setup.dialog.replace(() => <DialogModel />)
  await setup.waitForFrame((frame) => frame.includes("alpha") && frame.includes("beta"))
  await setup.mockInput.typeText("beta")
  await setup.waitForFrame((frame) => frame.includes("beta") && !frame.includes("alpha"))
  setup.mockInput.pressEnter()
  await setup.waitFor(() => setup.local.model.current()?.modelID === "beta")
  expect(setup.local.model.current()).toMatchObject({ modelID: "beta" })
})
