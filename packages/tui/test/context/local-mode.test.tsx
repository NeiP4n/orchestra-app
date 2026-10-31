import { expect, test } from "bun:test"
import { renderLocal } from "../fixture/local"
import { json } from "../fixture/tui-client"

const ids = (setup: Awaited<ReturnType<typeof renderLocal>>) =>
  setup.local.mode.list().map((mode) => String(mode.id))

test("offers Jailbreak and every bundled policy next to the ordinary work modes without any config", async () => {
  await using setup = await renderLocal({
    fetch: (url) => (url.pathname === "/api/config" ? json([]) : undefined),
  })

  await setup.waitFor(() => setup.local.mode.list().length > 0)
  expect(ids(setup)).toContain("coding")
  expect(ids(setup)).toContain("jailbreak")
  expect(ids(setup)).toContain("jailbreak:opus-v2")
  // The bare mode stays first in the section, so "auto by model" is the easy default.
  expect(ids(setup).indexOf("jailbreak:opus-v2")).toBeGreaterThan(ids(setup).indexOf("jailbreak"))
})

test("hides Jailbreak and its policies while the config turns it off", async () => {
  await using setup = await renderLocal({
    fetch: (url) =>
      url.pathname === "/api/config"
        ? json([
            { type: "document", info: {} },
            { type: "document", info: { jailbreak: { enabled: false } } },
          ])
        : undefined,
  })

  await setup.waitFor(() => setup.local.mode.list().length > 0)
  expect(ids(setup)).toContain("coding")
  expect(ids(setup).some((id) => id.startsWith("jailbreak"))).toBe(false)
})

test("keeps Jailbreak when an explicit prompt is configured", async () => {
  await using setup = await renderLocal({
    fetch: (url) =>
      url.pathname === "/api/config"
        ? json([{ type: "document", info: { jailbreak: { prompt: "deepseek-4-1" } } }])
        : undefined,
  })

  await setup.waitFor(() => setup.local.mode.list().some((mode) => String(mode.id) === "jailbreak"))
  expect(ids(setup)).toContain("jailbreak")
})
