import { expect, test } from "@playwright/test"
import { mockWorkspace } from "../utils/workspace"

test.use({ serviceWorkers: "block", reducedMotion: "reduce" })

test("a still Home network redraws with new theme colors without starting animation", async ({ page }, info) => {
  await page.addInitScript(() => {
    const original = CanvasRenderingContext2D.prototype.clearRect
    CanvasRenderingContext2D.prototype.clearRect = function (...args) {
      this.canvas.dataset.neuralFrames = String(Number(this.canvas.dataset.neuralFrames ?? 0) + 1)
      return original.call(this, ...args)
    }
  })
  await page.emulateMedia({ reducedMotion: "reduce" })
  await mockWorkspace(page, { name: "Still network", seed: { tabs: [] } })
  await page.goto("/")
  await expect(page.locator("html")).toHaveAttribute("data-motion", "off")
  const field = page.locator('canvas[data-component="neural-field"]')
  await expect(field).toBeVisible()
  await expect.poll(() => field.getAttribute("data-neural-frames")).not.toBeNull()
  const before = await field.evaluate((canvas) => {
    if (!(canvas instanceof HTMLCanvasElement)) throw new Error("Expected a neural canvas")
    return { image: canvas.toDataURL(), frames: canvas.dataset.neuralFrames }
  })
  await page.waitForTimeout(300)
  await expect(field).toHaveAttribute("data-neural-frames", before.frames!)
  await expect
    .poll(() =>
      field.evaluate((canvas) => {
        if (!(canvas instanceof HTMLCanvasElement)) throw new Error("Expected a neural canvas")
        return canvas.toDataURL()
      }),
    )
    .toBe(before.image)
  await page.evaluate(() => document.documentElement.style.setProperty("--v2-neural-dormant", "#ff0088"))
  await expect
    .poll(() =>
      field.evaluate((canvas) => {
        if (!(canvas instanceof HTMLCanvasElement)) throw new Error("Expected a neural canvas")
        return canvas.toDataURL()
      }),
    )
    .not.toBe(before.image)
  const recoloredFrames = await field.getAttribute("data-neural-frames")
  await page.waitForTimeout(300)
  await expect(field).toHaveAttribute("data-neural-frames", recoloredFrames!)
  await page.evaluate(() => document.documentElement.style.removeProperty("--v2-neural-dormant"))
  await page.screenshot({ path: info.outputPath("sculk-neural-still-home.png"), fullPage: true })
})

test("the real Animations switch restarts and stops the Home network", async ({ page }, info) => {
  await page.emulateMedia({ reducedMotion: "reduce" })
  await mockWorkspace(page, { name: "Network motion", seed: { tabs: [] } })
  await page.goto("/settings?tab=appearance")
  const animations = page.locator('[data-action="settings-animations"]').getByRole("switch")
  await expect(animations).not.toBeChecked()
  await page.locator('[data-action="settings-animations"] [data-slot="switch-control"]').click()
  await expect(page.locator("html")).toHaveAttribute("data-motion", "on")
  await page.getByRole("button", { name: "Back to app", exact: true }).click()
  await expect(page.locator('canvas[data-component="neural-field"]')).toBeVisible()
  await page.screenshot({ path: info.outputPath("sculk-neural-motion-home.png"), fullPage: true })
  await page.goto("/settings?tab=appearance")
  await expect(animations).toBeChecked()
  await page.locator('[data-action="settings-animations"] [data-slot="switch-control"]').click()
  await expect(page.locator("html")).toHaveAttribute("data-motion", "off")
  await page.reload()
  await expect(animations).not.toBeChecked()
  await expect(page.locator("html")).toHaveAttribute("data-motion", "off")
})
