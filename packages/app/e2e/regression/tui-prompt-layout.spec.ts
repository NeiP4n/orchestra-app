import { expect, test } from "@playwright/test"
import { openDraft } from "../utils/workspace"

for (const viewport of [
  { width: 1280, height: 800 },
  { width: 390, height: 844 },
  { width: 935, height: 350 },
]) {
  test(`the TUI-style prompt stage stays ordered and usable at ${viewport.width}x${viewport.height}`, async ({
    page,
  }, info) => {
    await page.setViewportSize(viewport)
    const creates: string[] = []
    page.on("request", (request) => {
      if (request.method() === "POST" && new URL(request.url()).pathname === "/api/session") creates.push(request.url())
    })
    const draft = await openDraft(page, {
      name: "TUI stage",
      seed: { settings: { appearance: { animations: false } } },
    })
    const logo = page.locator('[data-component="new-session-wordmark"]')
    const status = page.locator('[data-component="new-session-network-status"]')
    const composer = page.locator('[data-component="composer"]')
    await expect(status).toHaveText("network ready")
    await expect(logo).toBeVisible()
    await expect(composer).toBeVisible()
    const boxes = await Promise.all([logo.boundingBox(), status.boundingBox(), composer.boundingBox()])
    const [l, s, c] = boxes
    if (!l || !s || !c) throw new Error("Prompt stage bounds are unavailable")
    expect(l.y + l.height).toBeLessThanOrEqual(s.y + 1)
    expect(s.y + s.height).toBeLessThanOrEqual(c.y)
    expect(c.x).toBeGreaterThanOrEqual(0)
    expect(c.x + c.width).toBeLessThanOrEqual(viewport.width)
    await draft.editor.fill("Keep this draft while arranging the stage")
    await expect(draft.editor).toHaveText("Keep this draft while arranging the stage")
    expect(creates).toEqual([])
    const submit = page.locator('[data-action="composer-submit"]')
    await submit.scrollIntoViewIfNeeded()
    await expect(submit).toBeVisible()
    await expect(submit).toBeEnabled()
    await page.screenshot({
      path: info.outputPath(`tui-prompt-${viewport.width}x${viewport.height}.png`),
      fullPage: true,
    })
    // Draft writes are async and batched. Verify the actual IndexedDB commit before reload.
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            new Promise<boolean>((resolve, reject) => {
              const request = indexedDB.open("opencode-drafts", 1)
              request.onerror = () => reject(request.error)
              request.onsuccess = () => {
                const db = request.result
                const read = db.transaction("documents", "readonly").objectStore("documents").getAll()
                read.onerror = () => {
                  db.close()
                  reject(read.error)
                }
                read.onsuccess = () => {
                  db.close()
                  resolve(JSON.stringify(read.result).includes("Keep this draft while arranging the stage"))
                }
              }
            }),
        ),
      )
      .toBe(true)
    await page.reload()
    await expect(draft.editor).toHaveText("Keep this draft while arranging the stage")
    expect(creates).toEqual([])
  })
}
