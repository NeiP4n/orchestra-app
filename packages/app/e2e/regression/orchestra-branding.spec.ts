import { expect, test } from "@playwright/test"
import { mockWorkspace } from "../utils/workspace"

test.use({ serviceWorkers: "block", reducedMotion: "reduce" })

test("About identifies Orchestra and keeps upstream attribution inside notices", async ({ page }, info) => {
  await mockWorkspace(page, { name: "Brand QA", seed: { tabs: [] } })
  await page.goto("/settings?tab=about")
  const about = page.locator(".settings-about-content")

  await expect(about).toBeVisible()
  await expect(about.locator('[data-component="orchestra-about-wordmark"]')).toHaveText("ORCHESTRA")
  await expect(about.locator('[data-component="neural-dot"]')).toBeVisible()
  await expect(about.getByRole("link", { name: "github.com/NeiP4n/orchestra-app", exact: true })).toHaveAttribute(
    "href",
    "https://github.com/NeiP4n/orchestra-app",
  )
  await expect(about).not.toContainText(/OpenCode|Anomaly|Typeset|First published|First illustrated/i)
  await expect(about).toHaveCSS("font-family", /^"?IBM Plex Mono"?,/)
  await expect(about.getByRole("link", { name: "www.opencode.ai", exact: true })).toHaveCount(0)
  await expect(about).toContainText("Released under the MIT License")
  await expect(about).not.toContainText("Orchestra is a registered trademark")
  await expect(about.locator(".settings-about-wordmark")).toHaveCount(0)
  await expect(about.getByRole("button", { name: "Third-party notices" })).toBeVisible()
  await page.screenshot({ path: info.outputPath("orchestra-about.png"), fullPage: true })
})

test("the page and installed web app use the Orchestra neural icon", async ({ page }) => {
  await mockWorkspace(page, { name: "Brand assets QA", seed: { tabs: [] } })
  await page.goto("/")
  await expect(page).toHaveTitle("Orchestra")
  const favicon = await page.locator('link[rel="icon"]').getAttribute("href")
  const touch = await page.locator('link[rel="apple-touch-icon"]').getAttribute("href")

  expect(favicon).toMatch(/^\/icons\/(dev|beta|prod)\/favicon\.ico$/)
  expect(touch).toMatch(/^\/icons\/(dev|beta|prod)\/apple-touch-icon\.png$/)
  const response = await page.request.get(favicon!)

  expect(response.ok()).toBe(true)
  expect([...(await response.body()).subarray(0, 4)]).toEqual([0, 0, 1, 0])

  const pixel = await page.evaluate(async (src) => {
    const image = new Image()
    image.src = src!
    await image.decode()
    const canvas = document.createElement("canvas")
    canvas.width = image.width
    canvas.height = image.height
    const ctx = canvas.getContext("2d")!
    ctx.drawImage(image, 0, 0)

    return {
      width: image.width,
      height: image.height,
      center: [...ctx.getImageData(image.width / 2, image.height / 2, 1, 1).data],
    }
  }, touch)

  expect(pixel).toEqual({ width: 180, height: 180, center: [212, 197, 138, 255] })
  const manifest = await (await page.request.get("/site.webmanifest")).json()

  expect(manifest.name).toBe("Orchestra")
  expect(manifest.icons).toHaveLength(2)

  for (const icon of manifest.icons) expect((await page.request.get(icon.src)).ok()).toBe(true)
})

for (const saved of [false, true]) {
  test(`TUI mono covers settings, headings, controls and dialogs with ${saved ? "legacy saved" : "default"} fonts`, async ({ page }, info) => {
    await mockWorkspace(page, {
      name: "Global font QA",
      seed: {
        tabs: [],
        settings: { appearance: saved ? { sans: "Inter", terminal: "JetBrainsMono Nerd Font Mono" } : {} },
      },
    })
    await page.goto("/settings?tab=appearance")
    const mono = /^"?IBM Plex Mono"?,/
    await expect(page.locator("body")).toHaveCSS("font-family", mono)
    await expect(page.locator('[data-action="settings-ui-font"]')).toHaveAttribute("placeholder", "IBM Plex Mono")
    await expect(page.locator('[data-action="settings-terminal-font"]')).toHaveAttribute("placeholder", "IBM Plex Mono")

    for (const name of ["Appearance", "Preferences", "Notifications", "Shortcuts", "Providers", "About"]) {
      await page.getByRole("tab", { name, exact: true }).click()
      const panel = page.locator(".settings-content > .settings-panel:visible")
      await expect(panel).toHaveCSS("font-family", mono)

      const proportional = await panel.evaluate((root) => [...root.querySelectorAll("*")].flatMap((node) => {
        if (!(node instanceof HTMLElement) || !node.getClientRects().length || !node.textContent?.trim()) return []
        const family = getComputedStyle(node).fontFamily

        return family.startsWith('"IBM Plex Mono"') || family.startsWith("IBM Plex Mono") ? [] : [family]
      }))

      expect(proportional).toEqual([])
    }

    await page.getByRole("button", { name: "Third-party notices", exact: true }).click()
    await expect(page.getByRole("dialog")).toHaveCSS("font-family", mono)
    await page.keyboard.press("Escape")
    await page.evaluate(() => document.fonts.ready)
    await page.screenshot({ path: info.outputPath(`about-mono-${saved ? "saved" : "default"}.png`), fullPage: true })
    await page.setViewportSize({ width: 390, height: 844 })
    await page.screenshot({ path: info.outputPath(`about-mono-mobile-${saved ? "saved" : "default"}.png`), fullPage: true })
  })
}
