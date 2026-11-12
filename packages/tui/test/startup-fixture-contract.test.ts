import { expect, test } from "bun:test"
import { createApi, createFetch, json } from "./fixture/tui-client"

test("startup fixture has no imported browser definitions unless overridden", async () => {
  const fixture = createFetch()
  const api = createApi(fixture.fetch)
  expect(await api.orchestra.projectTemplate.browsers({ projectID: "prj_fixture" })).toBeNull()
  const overridden = createFetch((url) => url.pathname.endsWith("/browsers") ? json({ marker: "override" }) : undefined)
  expect(await (await overridden.fetch("http://test/api/orchestra/project-template/prj_fixture/browsers")).json()).toEqual({ marker: "override" })
})

test("startup fixture continuation defaults ON and persists OFF then ON in its own instance", async () => {
  const api = createApi(createFetch().fetch)
  expect(await api.config.continuation.get()).toEqual({ enabled: true })
  expect(await api.config.continuation.set({ enabled: false })).toEqual({ enabled: false })
  expect(await api.config.continuation.get()).toEqual({ enabled: false })
  expect(await api.config.continuation.set({ enabled: true })).toEqual({ enabled: true })
  expect(await createApi(createFetch().fetch).config.continuation.get()).toEqual({ enabled: true })
})

test("startup fixture still rejects unhandled routes", async () => {
  await expect(createFetch().fetch("http://test/api/this-route-does-not-exist")).rejects.toThrow("unexpected request")
})
