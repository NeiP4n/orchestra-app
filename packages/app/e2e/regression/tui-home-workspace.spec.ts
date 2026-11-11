import { expect, test } from "@playwright/test"
import { mockWorkspace } from "../utils/workspace"

test.use({ serviceWorkers: "block" })

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`Home has a real persisted draft in the TUI workspace at ${viewport.width}`, async ({ page }, info) => {
    await page.setViewportSize(viewport)
    const creates: string[] = []
    page.on("request", (request) => {
      if (request.method() === "POST" && new URL(request.url()).pathname === "/api/session") creates.push(request.url())
    })
    await mockWorkspace(page, { name: "TUI Home", seed: { tabs: [], settings: { appearance: { animations: false } } } })
    await page.goto("/")
    const editor = page.locator('[data-component="composer-editor"]')
    await expect(editor).toBeEditable()
    await editor.fill("A real Home draft without a backend Session")
    expect(creates).toEqual([])
    await expect(page).toHaveURL("/")
    await expect(page.locator('[data-slot="titlebar-tabs"] a')).toHaveCount(0)
    await page.screenshot({ path: info.outputPath(`tui-home-${viewport.width}.png`), fullPage: true })
    await expect
      .poll(() =>
        page.evaluate(async () => {
          return new Promise<boolean>((resolve) => {
            const request = indexedDB.open("opencode-drafts", 1)
            request.onsuccess = () => {
              const db = request.result
              const read = db.transaction("documents", "readonly").objectStore("documents").getAll()
              read.onsuccess = () => {
                db.close()
                resolve(JSON.stringify(read.result).includes("A real Home draft"))
              }
            }
          })
        }),
      )
      .toBe(true)
    await page.reload()
    await expect(editor).toHaveText("A real Home draft without a backend Session")
    expect(creates).toEqual([])
    await page.locator('[data-action="composer-submit"]').click()
    await expect(page).toHaveURL(/\/session\//)
    expect(creates).toHaveLength(1)
  })
}
