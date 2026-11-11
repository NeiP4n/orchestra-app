import { expect, test } from "@playwright/test"
import { mockWorkspace } from "../utils/workspace"

test.use({ serviceWorkers: "block", reducedMotion: "reduce" })

test("About identifies Orchestra and keeps OpenCode credits separate", async ({ page }, info) => {
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
  await expect(about.getByRole("heading", { name: "OpenCode upstream credits" })).toBeVisible()
  await expect(about.getByRole("link", { name: "www.opencode.ai", exact: true })).toHaveAttribute(
    "href",
    "https://opencode.ai",
  )
  await expect(about).toContainText("© Anomaly Innovations, Inc.")
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
