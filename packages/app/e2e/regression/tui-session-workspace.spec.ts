import { expect, test } from "@playwright/test"
import { seed, sessionHref } from "../utils/app"
import { fixture, mockStressTimeline } from "../utils/session-fixture"

for (const width of [1440, 390]) {
  test(`the TUI session workspace keeps real navigation and composer at ${width}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 })
    await mockStressTimeline(page)
    await seed(page, {
      projects: { local: [{ worktree: fixture.directory, expanded: true }] },
      lastProject: { local: fixture.directory },
      tabs: [fixture.sourceID, fixture.targetID],
      settings: { appearance: { animations: false } },
    })
    await page.goto(sessionHref(fixture.targetID))
    const workspace = page.locator('[data-component="tui-session-workspace"]')
    await expect(workspace).toBeVisible()
    await expect(workspace.locator("[data-session-title] h1")).toHaveText(fixture.expected.targetTitle)
    await expect(workspace.locator('[data-component="tui-session-status"]')).toBeVisible()
    await expect(workspace.locator('[data-timeline-row="UserMessage"]').first()).toBeVisible()
    const editor = workspace.locator('[data-component="composer-editor"]')
    await expect(editor).toBeEditable()
    await editor.fill("TUI session draft")
    const tree = workspace.locator('[data-slot="tui-project-tree"]')

    if (width === 1440) {
      await expect(tree).toBeVisible()

      const target = tree
        .locator('[data-component="home-session-row"]')
        .filter({ hasText: fixture.expected.sourceTitle })

      await expect(target).toBeVisible()
      await target.click()
      await expect(page).toHaveURL(sessionHref(fixture.sourceID))
      await expect(workspace.locator("[data-session-title] h1")).toHaveText(fixture.expected.sourceTitle)
      await expect(workspace.locator('[data-timeline-row="UserMessage"]').first()).toBeVisible()
    } else {
      await expect(tree).toHaveCount(0)
    }

    await expect(workspace.locator("[data-timeline-virtual-content]")).toHaveCSS("visibility", "visible")
    const latest = width === 1440 ? fixture.expected.sourceMessageIDs.at(-1) : fixture.expected.targetMessageIDs.at(-1)

    const jump = workspace.getByRole("button", { name: "Jump to latest", exact: true })

    if (await jump.isVisible()) await jump.click()
    await expect(workspace.locator(`[data-message-id="${latest}"]`).last()).toBeInViewport()
    await expect.poll(() => workspace.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true)
    await page.screenshot({ path: info.outputPath(`tui-session-${width}.png`), fullPage: true })
  })
}
