import { expect, story } from "../../storybook/playwright/story"

story("spaces an error between a shell result and expanded updates", async ({ mount }) => {
  const timeline = await mount("current-session-error-spacing--error-and-updates")
  const shell = timeline.locator('[data-component="bash-output"]')
  const error = timeline.locator('[data-kind="session-error-card"]')
  const updates = timeline.locator('[data-component="collapsed-tool-group"] [data-slot="collapsible-trigger"]')
  const shellBox = (await shell.boundingBox())!
  const errorBox = (await error.boundingBox())!
  const updatesBox = (await updates.boundingBox())!
  expect(errorBox.y - (shellBox.y + shellBox.height)).toBe(24)
  expect(updatesBox.y - (errorBox.y + errorBox.height)).toBe(8)
  expect(updatesBox.x).toBe(errorBox.x)
  await updates.click()
  const notice = timeline.locator('[data-slot="session-timeline-notice"]')
  await expect(notice).toContainText("Instructions updated")
  const expandedBox = (await updates.boundingBox())!
  expect((await notice.boundingBox())!.y - (expandedBox.y + expandedBox.height)).toBe(0)
  expect((await notice.boundingBox())!.x - expandedBox.x).toBe(12)
  expect(expandedBox.height).toBe(28)
})

for (const streaming of [false, true]) {
  story(`renders Mermaid in the ${streaming ? "streaming" : "completed"} timeline`, async ({ mount, page }, testInfo) => {
    // TEMP (Mermaid streaming->complete investigation): collect gated pipeline
    // traces and DOM snapshots. Remove with src/components/markdown-trace.ts.
    const traces: string[] = []
    if (streaming) {
      await page.addInitScript(() => {
        ;(window as unknown as { __MD_TRACE__: boolean }).__MD_TRACE__ = true
      })
      page.on("console", (message) => {
        if (message.text().startsWith("[md-trace]")) traces.push(message.text())
      })
      page.on("pageerror", (error) => {
        // Class + stack frames only: the message line can embed rendered text.
        const frames = (error.stack ?? "").split("\n").filter((line) => line.trimStart().startsWith("at "))
        traces.push([`[md-pageerror] ${error.name}`, ...frames].join("\n"))
      })
    }
    const snapshot = () =>
      page.evaluate(() =>
        [...document.querySelectorAll("[data-markdown-block]")].map((element) => {
          const block = element as HTMLElement
          return {
            key: block.dataset.markdownKey,
            hash: block.dataset.markdownHash,
            complete: block.dataset.markdownComplete,
            mermaid: !!block.querySelector('[data-component="markdown-mermaid"]'),
          }
        }),
      )
    const attachOnFailure = async (error: unknown) => {
      await testInfo
        .attach("md-dom-at-failure", { body: JSON.stringify(await snapshot().catch(() => "snapshot failed"), null, 2), contentType: "application/json" })
        .catch(() => undefined)
      await testInfo.attach("md-trace", { body: traces.join("\n"), contentType: "text/plain" }).catch(() => undefined)
      throw error
    }
    const run = async () => {
      await page.setViewportSize({ width: 390, height: 900 })
      const root = await mount("current-session-mermaid--diagrams", { args: { streaming } })
      const timeline = root.locator('[data-component="session-timeline"]')
      const diagrams = timeline.locator('[data-component="markdown-mermaid"] > svg')
      await expect(diagrams).toHaveCount(2)
      await expect(diagrams.nth(0)).toBeVisible()
      await expect(diagrams.nth(0)).toContainText("Client")
      await expect(diagrams.nth(1)).toBeVisible()
      await expect(diagrams.nth(1)).toContainText("Send prompt")
      await expect(timeline.locator('[data-mermaid-ready="true"]')).toHaveCount(2)
      await expect(timeline.locator('[data-mermaid-ready="true"] > pre:visible')).toHaveCount(0)

      if (streaming) {
        await testInfo.attach("md-dom-before-complete", {
          body: JSON.stringify(await snapshot(), null, 2),
          contentType: "application/json",
        })
        await root.getByRole("button", { name: "Complete response" }).click()
        // Integration contract after completion: the control flips back, both
        // diagrams stay rendered with their nodes, no fallback pre, and no lost or
        // duplicated content. The rendered diagram's direct source-code copy
        // control is intentionally display:none (markdown.css, mermaid-ready), so
        // copy is exercised on an ordinary visible fenced block in the story below.
        // The data-markdown-complete marker is STREAMING-renderer-only (set in
        // updateCodeBlock) and by design does not exist on the fresh static
        // owner after completion - it is asserted by the low-level markdown
        // specs instead.
        await expect(root.getByRole("button", { name: "Stream response" })).toBeVisible()
        await expect(diagrams).toHaveCount(2)
        await expect(diagrams.nth(0)).toBeVisible()
        await expect(diagrams.nth(0)).toContainText("Client")
        await expect(diagrams.nth(1)).toBeVisible()
        await expect(diagrams.nth(1)).toContainText("Send prompt")
        await expect(timeline.locator('[data-mermaid-ready="true"]')).toHaveCount(2)
        await expect(timeline.locator('[data-mermaid-ready="true"] > pre:visible')).toHaveCount(0)
        await expect(timeline.getByRole("heading", { name: "Request flow" })).toHaveCount(1)
        await expect(timeline.getByRole("heading", { name: "Request sequence" })).toHaveCount(1)
        // Decisive visual evidence for the completed render (reviewed externally).
        await testInfo.attach("mermaid-after-complete", {
          body: await page.screenshot({ fullPage: true }),
          contentType: "image/png",
        })
      }
    }
    // Any failure (mount, early assertions, the completion flip) attaches the trace.
    await run().catch(attachOnFailure)
  })
}

story("copies an ordinary fenced code block", async ({ mount, page }) => {
  // Companion to the Mermaid contract above: the copy action is exercised on an
  // ordinary visible fenced block, not on a rendered diagram (whose source-code
  // copy control is intentionally hidden). Low-level clipboard behaviour is
  // covered in markdown.spec.ts.
  const markdown = await mount("components-markdown--complete-response")
  const code = markdown.locator('[data-component="markdown-code"]').filter({ hasText: "export const value = 42" })
  await expect(code).toHaveCount(1)
  const copyHost = code.locator('[data-slot="markdown-copy-button"]')
  await expect(copyHost).toBeVisible()
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"])
  // The copy control sits at hover opacity 0 on the code block: hover first so the
  // interaction matches what a person sees (Playwright's click would hover implicitly).
  await code.hover()
  await copyHost.locator("button").click()
  await expect(copyHost).toHaveAttribute("data-copied", "true")
})

story("aligns the retry icon with the error label", async ({ mount }) => {
  const timeline = await mount("current-session-timeline-rows--provider-retry")
  const card = timeline.locator('[data-kind="session-retry-card"]')
  const icon = card.locator('[data-slot="icon-svg"]')
  const label = card.locator('[data-slot="session-turn-retry-message"]')
  await expect(icon).toBeVisible()
  await expect(label).toBeVisible()

  const [iconY, labelY] = await Promise.all([
    icon.evaluate((element) => element.getBoundingClientRect().y),
    label.evaluate((element) => element.getBoundingClientRect().y),
  ])

  expect(iconY).toBe(labelY)
})

story("centers the error icon on the first line of short and wrapped errors", async ({ mount }) => {
  const timeline = await mount("current-session-error-card--provider-errors")
  const cards = timeline.locator('[data-kind="session-error-card"]')

  await expect(cards).toHaveCount(2)

  const geometry = await cards.evaluateAll((elements) =>
    elements.map((card) => {
      const icon = card.querySelector('[data-slot="icon-svg"]')!.getBoundingClientRect()
      const message = card.querySelector('[data-slot="icon-svg"] + div')!
      const line = parseFloat(getComputedStyle(message).lineHeight)
      const box = message.getBoundingClientRect()

      return {
        lines: Math.round(box.height / line),
        offset: icon.top + icon.height / 2 - (box.top + line / 2),
      }
    }),
  )

  expect(geometry.map((card) => card.lines > 1)).toEqual([false, true])
  geometry.forEach((card) => expect(card.offset).toBeCloseTo(0, 0))
})

// Moved from packages/app/e2e/regression/session-timeline-context-state.spec.ts
story("preserves a collapsed context group through count and status updates", async ({ mount }) => {
  const timeline = await mount("current-session-research-agents--agent-research", { args: { scenario: "exploration" } })
  const group = timeline.locator('[data-timeline-part-ids="tool_context_read,tool_context_glob"]')
  const trigger = group.locator('[data-slot="collapsible-trigger"]')
  await expect(trigger).toHaveAttribute("aria-expanded", "false")
  await timeline.getByRole("button", { name: "Complete read" }).click()
  await expect(trigger).toHaveAttribute("aria-expanded", "false")
  await timeline.getByRole("button", { name: "Complete glob" }).click()
  await expect(trigger).toHaveAttribute("aria-expanded", "false")
})

// Moved from packages/app/e2e/regression/session-timeline-file-projection.spec.ts
story("renders a completed write through the production file component", async ({ mount }) => {
  const timeline = await mount("current-session-file-changes--changing-files", { args: { scenario: "write" } })
  const write = timeline.locator('[data-timeline-part-id="prt_file_projection_write"]')
  const file = write.getByRole("button", { name: /write\.ts/ })
  await expect(file).toHaveAttribute("aria-expanded", "false")
  await file.click()
  await expect(write.locator('[data-component="file"]')).toContainText("export const written = true")
})

// Moved from packages/app/e2e/regression/session-timeline-file-state.spec.ts
story("keeps patch file disclosures independent", async ({ mount }) => {
  const timeline = await mount("current-session-file-changes--changing-files", { args: { scenario: "patch" } })
  const wrapper = timeline.locator('[data-timeline-part-id="prt_nested_patch"]')
  const modified = wrapper.locator('[data-scope="apply-patch"] [data-type="update"] button')
  const added = wrapper.locator('[data-scope="apply-patch"] [data-type="add"] button')
  const deleted = wrapper.locator('[data-scope="apply-patch"] [data-type="delete"] button')
  await expect(wrapper.locator('[data-scope="apply-patch"] [aria-expanded="false"]')).toHaveCount(3)
  await deleted.click()
  await expect(deleted).toHaveAttribute("aria-expanded", "true")
  await expect(modified).toHaveAttribute("aria-expanded", "false")
  await modified.click()
  await expect(modified).toHaveAttribute("aria-expanded", "true")
  await deleted.click()
  await expect(deleted).toHaveAttribute("aria-expanded", "false")
  await expect(modified).toHaveAttribute("aria-expanded", "true")
  await expect(added).toHaveAttribute("aria-expanded", "false")
  await added.click()
  await expect(added).toHaveAttribute("aria-expanded", "true")
  await expect(modified).toHaveAttribute("aria-expanded", "true")
  await expect(deleted).toHaveAttribute("aria-expanded", "false")
})
