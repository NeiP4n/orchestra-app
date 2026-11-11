import { expect, test } from "@playwright/test"
import { mockWorkspace } from "../utils/workspace"

test.use({ serviceWorkers: "block" })

for (const width of [1440, 390]) {
  test(`connected shell pause switch waits for server settlement and restores state at ${width}`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 900 })

    const workspace = await mockWorkspace(page, {
      name: "Operator pause",
      seed: { tabs: [], settings: { appearance: { animations: false } } },
    })
    // Only transport is a fixture. This mounts the real shell, connection selector,
    // generated client and switch; the separate HTTP test exercises real execution.

    let enabled = true
    let finish: (() => void) | undefined
    const writes: boolean[] = []
    await page.route("**/api/config/continuation", async (route) => {
      if (route.request().method() === "PUT") {
        const value = route.request().postDataJSON()
        expect(typeof value.enabled).toBe("boolean")
        writes.push(value.enabled)
        await new Promise<void>((resolve) => {
          finish = resolve
        })
        enabled = value.enabled
      }

      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ enabled }) })
    })
    await page.goto("/")
    const toggle = page.getByRole("switch", { name: "Работа ИИ во всех проектах этого сервера" })
    await expect(toggle).toBeVisible()
    await expect(toggle).toBeEnabled()
    await expect(toggle).toHaveAttribute("aria-checked", "true")
    await toggle.click()
    await expect(toggle).toBeDisabled()
    await expect(toggle).toHaveAttribute("aria-busy", "true")
    await expect(toggle).not.toHaveText(/ПАУЗА/)
    expect(writes).toEqual([false])
    finish!()
    await expect(toggle).toBeEnabled()
    await expect(toggle).toHaveText(/ПАУЗА/)
    await expect(toggle).toHaveAttribute("aria-checked", "false")
    await page.screenshot({ path: info.outputPath(`continuation-${width}.png`), fullPage: true })
    await page.reload()
    await expect(toggle).toBeEnabled()
    await expect(toggle).toHaveAttribute("aria-checked", "false")
    expect(writes).toEqual([false])
    enabled = true
    await workspace.push([{ type: "config.continuation.updated", data: { enabled } }])
    await expect(toggle).toHaveAttribute("aria-checked", "true")
  })
}
