import { expect, test } from "@playwright/test"
import { seed } from "../utils/app"
import { fixture, mockStressTimeline } from "../utils/session-fixture"
import { toolCalled, toolInputStarted } from "../utils/timeline"

test("real server events reach a stable TUI tool bridge on the Home canvas", async ({ page }, info) => {
  await page.addInitScript(() => {
    const original = CanvasRenderingContext2D.prototype.fillText
    CanvasRenderingContext2D.prototype.fillText = function (text, x, y, maxWidth) {
      if (text.startsWith("▸ ")) this.canvas.dataset.neuralToolLabel = text

      if (maxWidth === undefined) return original.call(this, text, x, y)

      return original.call(this, text, x, y, maxWidth)
    }
  })
  const server = await mockStressTimeline(page)

  await seed(page, {
    projects: { local: [{ worktree: fixture.directory, expanded: true }] },
    lastProject: { local: fixture.directory },
    tabs: [],
    settings: { appearance: { animations: true } },
  })
  await page.goto("/")
  const canvas = page.locator('[data-component="neural-field"]')

  await expect(canvas).toBeVisible()
  await expect(page.locator("html")).toHaveAttribute("data-motion", "on")
  await server.push([
    toolInputStarted({
      sessionID: fixture.targetID,
      assistantMessageID: "msg_neural",
      id: "call_neural",
      name: "read",
    }),
    toolCalled({
      sessionID: fixture.targetID,
      assistantMessageID: "msg_neural",
      id: "call_neural",
      input: {},
      executed: true,
    }),
  ])
  await expect(canvas).toHaveAttribute("data-neural-tool-label", "▸ read")
  await page.screenshot({ path: info.outputPath("tui-live-tool-bridge.png"), fullPage: true })
})
