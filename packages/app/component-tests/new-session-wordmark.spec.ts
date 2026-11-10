import { expect, story } from "../../storybook/playwright/story"

for (const theme of ["light", "dark"]) {
  for (const direction of ["ltr", "rtl"]) {
    story(`shimmers once over the visible wordmark (${theme}, ${direction})`, async ({ mount, page }, testInfo) => {
      await page.emulateMedia({ reducedMotion: "no-preference" })
      const component = await mount("app-new-session-wordmark--reveal", { globals: { theme, direction } })
      const logo = component.locator('[data-component="new-session-wordmark"]')
      const reveal = logo.locator('[data-slot="wordmark-reveal"]')
      const shimmer = logo.locator(".wordmark-shimmer")
      const base = logo.locator("svg").first()
      await expect(base).toHaveCSS("opacity", "0.16")
      await expect(shimmer).toHaveCSS("animation-iteration-count", "1")
      await expect(logo.locator("g[mask]")).toHaveCount(0)
      await expect(shimmer).toHaveCSS("color", "rgb(255, 255, 255)")
      await expect(shimmer).toHaveCSS("mix-blend-mode", "screen")
      // The Fan mark replaced the old filled-path wordmark. Test its semantic slots,
      // not path indices that now point to unfilled arcs.
      const arcs = base.locator('[data-slot="logo-mark-arcs"]')
      const rays = base.locator('[data-slot="logo-mark-ray"]')
      const podium = base.locator('[data-slot="logo-mark-podium"]')
      await expect(arcs).toHaveCount(3)
      await expect(rays).toHaveCount(5)
      await expect(podium).toHaveCount(1)
      await expect(arcs.first()).toHaveAttribute("fill", "none")
      await expect(arcs.first()).toHaveAttribute("stroke", "var(--icon-spark-base)")
      await expect(base.locator('path[data-slot="logo-mark-ray"][stroke="var(--icon-weak-base)"]')).toHaveCount(4)
      await expect(podium).toHaveAttribute("fill", "var(--icon-strong-base)")
      await expect(base.locator("text")).toHaveText("ORCHESTRA")
      await expect(base.locator("text")).toHaveAttribute("fill", "currentColor")
      await expect(base.locator("text")).toHaveAttribute("direction", "ltr")
      const fits = await base.locator("text").evaluate((element) => {
        const bounds = (element as SVGGraphicsElement).getBBox()
        return bounds.x >= 0 && bounds.x + bounds.width <= 720
      })
      expect(fits).toBe(true)

      await logo.evaluate((element) => {
        element.getAnimations({ subtree: true }).forEach((animation) => {
          animation.pause()
          animation.currentTime = 0
        })
      })
      await expect(reveal).toHaveCSS("opacity", "1")
      await expect(reveal).toHaveCSS("animation-name", "none")
      await expect(shimmer).toHaveCSS("mask-position", "100% 0px")

      await logo.evaluate((element) => {
        element.getAnimations({ subtree: true }).forEach((animation) => (animation.currentTime = 400))
      })
      await expect(shimmer).toHaveCSS("mask-position", "50% 0px")
      await expect(shimmer).toHaveCSS("opacity", theme === "dark" ? "0.0672" : "0.45")
      const swept = await logo.screenshot({ path: testInfo.outputPath("wordmark-shimmer.png") })

      await logo.evaluate((element) => {
        element.getAnimations({ subtree: true }).forEach((animation) => animation.finish())
      })
      await expect(reveal).toHaveCSS("opacity", "1")
      await expect(shimmer).toHaveCSS("opacity", "0")
      await expect(shimmer).toHaveCSS("mask-position", "0% 0px")
      const settled = await logo.screenshot({ path: testInfo.outputPath("wordmark-settled.png") })

      const brightness = await page.evaluate(
        async (screenshots) => {
          const pixels = await Promise.all(
            screenshots.map(async (screenshot) => {
              const image = new Image()
              image.src = `data:image/png;base64,${screenshot}`
              await image.decode()
              const canvas = new OffscreenCanvas(image.width, image.height)
              const context = canvas.getContext("2d")

              if (!context) throw new Error("Cannot read screenshot pixels")
              context.drawImage(image, 0, 0)

              return context.getImageData(0, 0, image.width, image.height).data
            }),
          )

          return {
            min: pixels[0].reduce(
              (min, value, index) => (index % 4 === 3 ? min : Math.min(min, value - pixels[1][index])),
              0,
            ),
            max: pixels[0].reduce(
              (max, value, index) => (index % 4 === 3 ? max : Math.max(max, value - pixels[1][index])),
              0,
            ),
          }
        },
        [swept.toString("base64"), settled.toString("base64")],
      )

      expect(brightness.min).toBeGreaterThanOrEqual(0)
      expect(brightness.max).toBeGreaterThanOrEqual(5)
    })
  }

  story(`shows a static wordmark with reduced motion (${theme})`, async ({ mount, page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" })
    await page.setViewportSize({ width: 360, height: 640 })
    const component = await mount("app-new-session-wordmark--reveal", { globals: { theme } })
    const logo = component.locator('[data-component="new-session-wordmark"]')
    await expect(logo.locator("svg").first()).toHaveCSS("opacity", "0.16")
    await expect(logo.locator('[data-slot="wordmark-reveal"]')).toHaveCSS("opacity", "1")
    await expect(logo.locator(".wordmark-shimmer")).toHaveCSS("opacity", "0")
    expect(await logo.evaluate((element) => element.getAnimations({ subtree: true }).length)).toBe(0)
    expect(await logo.evaluate((element) => element.getBoundingClientRect().right <= innerWidth)).toBe(true)
  })
}
