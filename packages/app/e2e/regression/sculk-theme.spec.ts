import { expect, test } from "@playwright/test"
import { mockWorkspace, openSession } from "../utils/workspace"

test.use({ serviceWorkers: "block", colorScheme: "light" })

test("fresh web uses the dark TUI Sculk palette on a light OS across Home and settings", async ({ page }, info) => {
  await mockWorkspace(page, { name: "Sculk QA", seed: { tabs: [] } })
  await page.goto("/settings?tab=appearance")
  await expect(page.locator("html")).toHaveAttribute("data-theme", "sculk")
  await expect(page.locator("html")).toHaveAttribute("data-color-scheme", "dark")
  await expect(page.locator('[data-action="settings-color-scheme"]')).toHaveText("Dark")
  await expect
    .poll(() =>
      page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue("--v2-background-bg-base").trim(),
      ),
    )
    .toBe("#050f15")
  await expect
    .poll(() =>
      page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--v2-text-text-base").trim()),
    )
    .toBe("#bff7f2")
  await page.screenshot({ path: info.outputPath("sculk-dark-appearance.png"), fullPage: true })
  await page.getByRole("button", { name: "Back to app", exact: true }).click()
  await expect(page.locator('[data-slot="home-panel"]')).toBeVisible()
  await page.screenshot({ path: info.outputPath("sculk-dark-home.png"), fullPage: true })
})

test("a selected theme and explicit light scheme survive reload and reset keeps the scheme", async ({ page }) => {
  await mockWorkspace(page, { name: "Saved theme QA", seed: { tabs: [], theme: { id: "dracula", scheme: "light" } } })
  await page.goto("/settings?tab=appearance")
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dracula")
  await expect(page.locator("html")).toHaveAttribute("data-color-scheme", "light")
  await page.reload()
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dracula")
  await expect(page.locator("html")).toHaveAttribute("data-color-scheme", "light")
  await page.locator('[data-action="settings-theme-reset"]').click()
  await expect(page.locator("html")).toHaveAttribute("data-theme", "sculk")
  await expect(page.locator("html")).toHaveAttribute("data-color-scheme", "light")
})

test("fresh session uses the same dark TUI Sculk palette", async ({ page }, info) => {
  await openSession(page, { name: "Sculk session QA" })
  await expect(page.locator("html")).toHaveAttribute("data-theme", "sculk")
  await expect(page.locator("html")).toHaveAttribute("data-color-scheme", "dark")
  await page.screenshot({ path: info.outputPath("sculk-dark-session.png"), fullPage: true })
})
