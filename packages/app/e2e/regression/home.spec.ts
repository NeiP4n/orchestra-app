import { expect, test, type Page } from "@playwright/test"
import { holdRoute, NO_PROVIDER, project, REMOTE_SERVER, seed, sessionHref } from "../utils/app"
import { mockOpenCodeServer } from "../utils/mock-server"
import { fixture, mockStressTimeline } from "../utils/session-fixture"
import { mockRemoteServer } from "../utils/workspace"
import { APP_READY_TIMEOUT, expectAppVisible } from "../utils/waits"

test.use({ serviceWorkers: "block" })

const row = (page: Page, title: string) =>
  page.locator('[data-component="home-session-row"]').filter({ hasText: title })

async function openHome(page: Page, input: Parameters<typeof mockStressTimeline>[1] = {}) {
  await mockStressTimeline(page, input)
  await seed(page, {
    projects: { local: [{ worktree: fixture.directory, expanded: true }] },
    lastProject: { local: fixture.directory },
  })
  await page.goto("/")
}

test("the session context menu renames, exports, and deletes a Home session", async ({ page }) => {
  await openHome(page)
  const target = row(page, fixture.expected.targetTitle)
  await expect(target).toBeVisible()

  await target.focus()
  await target.press("Shift+F10")
  await expect(page.getByRole("menuitem", { name: "Rename" })).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(page.getByRole("menuitem", { name: "Rename" })).toBeHidden()
  await expect(target).toBeFocused()

  const box = await target.boundingBox()
  await target.click({ button: "right", position: { x: 48, y: 12 } })
  await expect(page).toHaveURL("/")
  await expect(page.getByRole("menuitem")).toHaveText(["Rename", "Export…", "Delete…"])
  const menu = await page.locator('[data-component="menu-v2-content"]').boundingBox()
  expect(Math.abs((menu?.x ?? 0) - (box?.x ?? 0) - 48)).toBeLessThan(4)

  await page.getByRole("menuitem", { name: "Rename" }).click()
  const title = page.locator('[data-component="home-session-rename"]')
  await expect(title).toBeFocused()
  await expect(title).toHaveValue(fixture.expected.targetTitle)
  await title.fill("Renamed from Home")

  const renamed = page.waitForRequest(
    (request) =>
      request.method() === "PATCH" && new URL(request.url()).pathname.endsWith(`/session/${fixture.targetID}`),
  )

  await title.press("Enter")
  expect((await renamed).postDataJSON()).toEqual({ title: "Renamed from Home" })
  const renamedRow = row(page, "Renamed from Home")
  await renamedRow.click()
  await expect(page).toHaveURL(new RegExp(`/session/${fixture.targetID}$`))
  await expect(page.locator('[data-slot="titlebar-tabs"] a').filter({ hasText: "Renamed from Home" })).toBeVisible()
  await page.getByRole("button", { name: "Home" }).click()
  await expect(page).toHaveURL("/")

  await renamedRow.click({ button: "right" })
  const download = page.waitForEvent("download")
  await page.getByRole("menuitem", { name: "Export…" }).click()
  expect((await download).suggestedFilename()).toBe("renamed-from-home.json")

  await renamedRow.click({ button: "right" })
  await page.getByRole("menuitem", { name: "Delete…" }).click()
  const dialog = page.getByRole("dialog")
  await expect(dialog).toContainText('Delete session "Renamed from Home"?')

  const removed = page.waitForRequest(
    (request) => request.method() === "DELETE" && new URL(request.url()).pathname.endsWith(`/${fixture.targetID}`),
  )

  await dialog.getByRole("button", { name: "Delete session" }).click()
  await removed
  await expect(renamedRow).toBeHidden()
})

test("Home shows loaded sessions before the location request resolves", async ({ page }) => {
  const location = await holdRoute(page, (url) => url.pathname === "/api/location")
  await openHome(page)
  await expectAppVisible(row(page, fixture.expected.sourceTitle))
  location.release()
})

test("the Archived toggle never overlaps a session group header", async ({ page }) => {
  await openHome(page)
  await expect(row(page, fixture.expected.targetTitle)).toBeVisible()

  // The toggle lives in the sticky header row; the group titles stick below
  // it. If the two share one row, the toggle paints over the title.
  const measure = () =>
    page.evaluate(() => {
      const rect = (el: Element | null) => {
        if (!el) return null

        const r = el.getBoundingClientRect()

        return { x: r.x, y: r.y, width: r.width, height: r.height }
      }

      const button = document.querySelector('[data-action="home-toggle-archived-sessions"]')

      const headers = [...document.querySelectorAll("section div")].flatMap((el) => {
        if (getComputedStyle(el).position !== "sticky") return []

        // The older group reads "Recent sessions" when today and
        // yesterday are empty (controller groupSessions).
        if (!/^(Today|Yesterday|Older|Recent sessions)$/.test((el.textContent ?? "").trim())) return []

        return [{ text: (el.textContent ?? "").trim(), box: rect(el) }]
      })

      return { button: rect(button), headers }
    })

  const assertNoOverlap = (measured: Awaited<ReturnType<typeof measure>>) => {
    expect(measured.button).not.toBeNull()
    expect(measured.headers.length).toBeGreaterThan(0)

    for (const header of measured.headers) {
      const button = measured.button!
      const box = header.box!

      const overlaps =
        Math.min(button.x + button.width, box.x + box.width) - Math.max(button.x, box.x) > 0 &&
        Math.min(button.y + button.height, box.y + box.height) - Math.max(button.y, box.y) > 0

      expect(overlaps, `Archived toggle overlaps the "${header.text}" group header`).toBe(false)
    }
  }

  assertNoOverlap(await measure())

  // Scroll the list so a group header sticks, and check again: a stuck
  // header must sit below the toggle row, not under it.
  await page.evaluate(() => {
    // SAFETY: querySelector returns Element | null and the toggle is an
    // HTMLElement when present; the loop only reads layout properties.
    let el = document.querySelector('[data-action="home-toggle-archived-sessions"]') as HTMLElement | null

    while (el) {
      if (el.scrollHeight > el.clientHeight + 10) {
        el.scrollTop = el.scrollHeight
        break
      }

      el = el.parentElement
    }
  })

  await page.waitForFunction(() => {
    // SAFETY: same as above: the toggle is an HTMLElement when present.
    let el = document.querySelector('[data-action="home-toggle-archived-sessions"]') as HTMLElement | null

    while (el) {
      if (el.scrollHeight > el.clientHeight + 10) return el.scrollTop > 0

      el = el.parentElement
    }

    return true
  })

  assertNoOverlap(await measure())
})

test("Home and the directory picker load without newer browser APIs", async ({ page }) => {
  await page.addInitScript(() => {
    // Safari 16.6 has none of these APIs. Remove them before the web entry runs.
    // SAFETY: `Partial` only makes the static method optional so `delete` type-checks; the target is the real global.
    delete (Map as Partial<typeof Map>).groupBy
    // SAFETY: as above, for the real global `Promise`.
    delete (Promise as Partial<typeof Promise>).withResolvers
    // SAFETY: as above, for the real global `Promise`.
    delete (Promise as Partial<typeof Promise>).try
  })
  await openHome(page, { fileList: () => [] })
  const target = row(page, fixture.expected.targetTitle)
  await expect(target).toBeVisible()

  await page.getByRole("button", { name: "Add project", exact: true }).click()
  const dialog = page.getByRole("dialog")
  await expect(dialog.getByRole("button", { name: "Select folder", exact: true })).toBeEnabled()
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click()
  await expect(dialog).toBeHidden()
  await expect(target).toBeVisible()
})

test("adding a project to a signed-out server re-pairs it, then continues at the paired address", async ({ page }) => {
  // The saved address rejects the new token, so saving moves the server to the link's address.
  const paired = "http://127.0.0.1:4098"
  await mockRemoteServer(page, { name: "Remote", password: "old-password" })
  await mockOpenCodeServer(page, {
    server: paired,
    directory: "/remote/paired",
    project: project({ id: "proj_paired", directory: "/remote/paired" }),
    provider: NO_PROVIDER,
    sessions: [],
    pageMessages: () => ({ items: [] }),
    fileList: () => [],
    password: "session-token",
    pairing: { code: "one-time-code", token: "session-token" },
  })
  await openHome(page, { fileList: () => [] })
  const remote = page.locator("[data-home-row]").filter({ hasText: "Remote" })
  await expect(page.getByRole("button", { name: "Authenticate", exact: true })).toBeVisible()

  await remote.getByRole("button", { name: "Add project", exact: true }).click()
  const editor = page.getByRole("dialog", { name: "Edit server" })
  await editor.getByLabel("Pairing link", { exact: true }).fill(`${paired}/auth/connect/one-time-code`)
  await editor.getByRole("button", { name: "Save", exact: true }).click()

  // The folder picker reads the paired address; the removed one would reject the request.
  const picker = page.getByRole("dialog").filter({ has: page.getByRole("button", { name: "Select folder" }) })
  await expect(picker.getByRole("button", { name: "Select folder", exact: true })).toBeEnabled()
  await expect(picker.getByText("Unable to read this folder")).toHaveCount(0)
})

test("a server whose saved password changes works with the new password", async ({ page }) => {
  const accepted = { password: "old-password" }
  await mockOpenCodeServer(page, {
    server: REMOTE_SERVER,
    directory: "/remote/project",
    project: project({ id: "proj_remote", directory: "/remote/project" }),
    provider: NO_PROVIDER,
    sessions: [],
    pageMessages: () => ({ items: [] }),
    fileList: () => [],
    password: () => accepted.password,
  })
  // Saved with the password the server accepts until the test changes it.
  await seed(page, {
    storage: {
      "opencode.global.dat:server": {
        list: [{ type: "http", displayName: "Remote", http: { url: REMOTE_SERVER, password: "old-password" } }],
      },
    },
  })
  await openHome(page, { fileList: () => [] })
  const remote = page.locator("[data-home-row]").filter({ hasText: "Remote" })
  const picker = page.getByRole("dialog").filter({ has: page.getByRole("button", { name: "Select folder" }) })

  // Use the server once, so its controller exists with the old password.
  await remote.getByRole("button", { name: "Add project", exact: true }).click()
  await expect(picker.getByRole("button", { name: "Select folder", exact: true })).toBeEnabled()
  await picker.getByRole("button", { name: "Cancel", exact: true }).click()
  await expect(picker).toHaveCount(0)

  await remote.getByRole("button", { name: "More options", exact: true }).click()
  await page.getByRole("menuitem", { name: "Edit", exact: true }).click()
  const editor = page.getByRole("dialog", { name: "Edit server" })
  // The server now rejects the old password, as after `opencode service set password`. The editor verifies the
  // typed password as it changes, so the server must already reject the old one when the field is filled: a check
  // that leaves before this flip would come back 401 and the editor would keep the old credentials.
  accepted.password = "new-password"
  await editor.getByPlaceholder("password").fill("new-password")
  await editor.getByRole("button", { name: "Save", exact: true }).click()
  await expect(editor).toHaveCount(0)

  // The picker reads the folder through the server's controller, which must use the saved password now.
  await remote.getByRole("button", { name: "Add project", exact: true }).click()
  await expect(picker.getByRole("button", { name: "Select folder", exact: true })).toBeEnabled()
  await expect(picker.getByText("Unable to read this folder")).toHaveCount(0)
})

const recovery = "C:/OpenCode/Worktrees/project-menu-recovery"

const worktree =
  "C:/OpenCode/Worktrees/project-42/long-folder-name-for-checking-wrapped-worktree-paths/another-long-folder-name"

// These cases drive the whole stress timeline through the settings surface twice, so on a loaded runner the same work
// takes over a minute; a 60s default would report its own budget instead of the assertion that broke.
const STRESS_CASE_TIMEOUT = 120_000

// Each step waits on the app rather than on a timer; on a loaded runner the settings surface alone can take longer than
// the suite's 10s assertion budget, so these cases carry an explicit one instead of failing on the default.
const STRESS_ASSERTION_TIMEOUT = 30_000

for (const state of [
  { name: "local", directory: fixture.directory, icon: "monitor" },
  { name: "worktree", directory: worktree, icon: "outline-worktree" },
  { name: "closed worktree", directory: recovery, icon: "outline-worktree", recovery: "closed" },
  { name: "unopened worktree", directory: recovery, icon: "outline-worktree", recovery: "unopened" },
]) {
  test(`the session project menu opens settings and Home for a ${state.name} project`, async ({ page }) => {
    test.setTimeout(STRESS_CASE_TIMEOUT)
    const check = expect.configure({ timeout: STRESS_ASSERTION_TIMEOUT })
    await page.setViewportSize({ width: 1440, height: 900 })
    const workspace = state.directory !== fixture.directory
    const messages = Promise.withResolvers<void>()
    await mockStressTimeline(page, {
      directory: state.directory,
      // An image icon keeps the avatar initial out of the menu item text.
      project: {
        ...fixture.project,
        sandboxes: workspace ? [state.directory] : [],
        icon: {
          url: `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"/>')}`,
        },
      },
      sessions: fixture.sessions.map((item) => ({ ...item, directory: state.directory })),
      beforeMessagesResponse: (input) =>
        state.recovery && input.sessionID === fixture.targetID ? messages.promise : Promise.resolve(),
    })

    // An unopened project has no stored project list or tabs.
    if (state.recovery !== "unopened")
      await seed(page, {
        projects: { local: [{ worktree: fixture.directory, expanded: true }] },
        lastProject: { local: fixture.directory },
        tabs: [fixture.sourceID, fixture.targetID],
      })
    const name = fixture.project.name

    if (state.recovery === "closed") {
      await page.goto("/")
      const project = page.locator('[data-component="home-project-row"]').filter({ hasText: name })
      await project.locator("..").getByRole("button", { name: "More options", exact: true }).click()
      await page.getByRole("menuitem", { name: "Close", exact: true }).click()
      await check(project).toHaveCount(0)
      await page.locator(`[data-titlebar-tab-link][href="${sessionHref(fixture.targetID)}"]`).click()
    }

    if (state.recovery !== "closed") await page.goto(sessionHref(fixture.targetID))

    const header = page.locator("[data-session-title]")
    const trigger = header.getByRole("button", { name, exact: true })
    const menu = page.getByRole("menu", { name, exact: true })
    const projectItem = menu.getByRole("menuitem", { name, exact: true })
    const pathItem = menu.getByRole("menuitem", { name: state.directory, exact: true })
    const settings = page.getByTestId("settings-screen")
    await check(header.getByRole("heading")).toHaveText(fixture.expected.targetTitle, { timeout: APP_READY_TIMEOUT })
    // Drive the header menu only once the header is painted and enabled; a late paint then reports here, not in a click retry loop.
    await check(trigger).toBeVisible({ timeout: APP_READY_TIMEOUT })
    await check(trigger).toBeEnabled({ timeout: APP_READY_TIMEOUT })

    for (const loaded of state.recovery ? [false, true] : [true]) {
      if (state.recovery && loaded) {
        messages.resolve()
        await check(header.getByRole("button", { name: "More options", exact: true })).toBeVisible()
      }

      await check(trigger.locator("use")).toHaveAttribute("href", `#opencode-v2-icon-${state.icon}`, {
        timeout: APP_READY_TIMEOUT,
      })
      await trigger.click({ timeout: APP_READY_TIMEOUT })
      await check(menu.getByRole("menuitem")).toHaveText([name, state.directory, "Edit project"])
      await check(pathItem).toBeDisabled()
      await page.keyboard.press("Escape")
      await check(menu).toBeHidden()
      await check(trigger).toBeFocused()
      await trigger.press("ArrowDown")
      await check(projectItem).toBeFocused()
      await page.keyboard.press("ArrowDown")
      await check(pathItem).toBeFocused()

      for (const key of ["Enter", "Space"]) {
        await page.keyboard.press(key)
        await check(menu).toBeVisible()
        await check(pathItem).toBeFocused()
      }

      await page.keyboard.press("ArrowDown")
      await page.keyboard.press("Enter")
      await check(settings.getByRole("textbox", { name: "Project name", exact: true })).toHaveValue(name)
      await settings.getByRole("button", { name: "Back to projects", exact: true }).click()
      await settings.getByRole("button", { name: "Back to app", exact: true }).click()
      await check(settings).toBeHidden()
      // Back to app returns to the session settings were opened from; wait for that route instead of letting the next
      // click race a navigation that is still in flight (the settings surface detaches before the route settles).
      await check(page).toHaveURL(sessionHref(fixture.targetID), { timeout: APP_READY_TIMEOUT })
      await check(header.getByRole("heading")).toHaveText(fixture.expected.targetTitle, { timeout: APP_READY_TIMEOUT })
    }

    await trigger.click({ timeout: APP_READY_TIMEOUT })
    await projectItem.click()
    await check(page).toHaveURL(new URL("/", page.url()).href)
    const project = page.locator('[data-component="home-project-row"]').filter({ hasText: name })
    await check(project).toHaveAttribute("data-selected", "")
    await check(
      page.locator(`[data-component="home-session-row-container"][data-session-id="${fixture.targetID}"]`),
    ).toBeVisible()
  })
}

test("the project menu path arrow has a glyph when the page has an older icon sprite", async ({ page }) => {
  test.setTimeout(STRESS_CASE_TIMEOUT)
  const check = expect.configure({ timeout: STRESS_ASSERTION_TIMEOUT })
  await mockStressTimeline(page)
  await seed(page, { projects: { local: [{ worktree: fixture.directory, expanded: true }] }, tabs: [fixture.targetID] })
  // A page cached before the arrow icon shipped carries a sprite without it.
  await page.route(
    (url) => url.pathname === sessionHref(fixture.targetID),
    async (route) => {
      const response = await route.fetch()
      await route.fulfill({
        response,
        body: (await response.text()).replace(
          '<div id="root"',
          '<svg id="opencode-v2-icon-sprite" width="0" height="0" aria-hidden="true"><symbol id="opencode-v2-icon-monitor" viewBox="0 0 16 16"><path d="M1 1h14v14H1z"/></symbol></svg><div id="root"',
        ),
      })
    },
  )
  await page.goto(sessionHref(fixture.targetID))
  const header = page.locator("[data-session-title]")
  await check(header.getByRole("heading")).toHaveText(fixture.expected.targetTitle, { timeout: APP_READY_TIMEOUT })
  const trigger = header.getByRole("button", { name: fixture.project.name, exact: true })
  // Drive the header menu only once the header is painted and enabled; a late paint then reports here, not in a click retry loop.
  await check(trigger).toBeVisible({ timeout: APP_READY_TIMEOUT })
  await check(trigger).toBeEnabled({ timeout: APP_READY_TIMEOUT })
  await trigger.click({ timeout: APP_READY_TIMEOUT })

  const arrow = page
    .getByRole("menu")
    .getByRole("menuitem", { name: fixture.directory, exact: true })
    .locator('[data-slot="session-project-open-icon"]')

  await check(arrow).toHaveCount(1)
  await expect
    .poll(() => arrow.locator("svg").evaluate((element: SVGSVGElement) => element.getBBox().width))
    .toBeGreaterThan(0)
  await check(page.locator("#opencode-v2-icon-sprite")).toHaveCount(1)
})

const societyCreate = (page: Page) =>
  page.waitForRequest(
    (request) => request.method() === "POST" && new URL(request.url()).pathname === "/api/orchestra/society",
  )

test("Home creates an AI team from the goal alone", async ({ page }) => {
  await openHome(page)
  const created = await holdRoute(page, (url) => url.pathname === "/api/orchestra/society", { method: "POST" })
  // The Society's chat is read only after the dialog is closed; holding it proves the closure does not wait for it.
  const read = await holdRoute(page, (url) => url.pathname === "/api/session/ses_mock_society", { method: "GET" })
  await page.locator('[data-action="home-create-ai-team"]').click()

  const dialog = page.getByRole("dialog")
  const goal = dialog.getByLabel("Goal", { exact: true })
  await expect(goal).toBeFocused()
  await goal.fill("Ship the relay")
  // Shift+Enter keeps the line break the textarea inserts; plain Enter creates the team.
  await goal.press("Shift+Enter")
  await expect(goal).toHaveValue("Ship the relay\n")
  await page.keyboard.type("today")

  const request = societyCreate(page)
  await goal.press("Enter")
  // The creation in flight locks the fields and says what the button is doing.
  await expect(dialog.getByRole("button", { name: "Creating team…", exact: true })).toBeVisible()
  await expect(goal).toBeDisabled()
  expect((await request).postDataJSON()).toEqual({ goal: "Ship the relay\ntoday", team: "system" })

  created.release()
  // The Society exists once the create answers: a read that never answers must not keep the Create button reachable,
  // where pressing it again would create a second Society.
  await expect(dialog).toHaveCount(0)
  read.release()
})

test("Home sends the name and parent folder typed in More options", async ({ page }) => {
  await openHome(page)
  await page.locator('[data-action="home-create-ai-team"]').click()

  const dialog = page.getByRole("dialog")
  await dialog.getByLabel("Goal", { exact: true }).fill("Ship the relay")
  // The extra fields stay out of the way until asked for.
  await expect(dialog.getByLabel("Name", { exact: true })).toHaveCount(0)
  await dialog.getByRole("button", { name: "More options", exact: true }).click()
  await dialog.getByLabel("Name", { exact: true }).fill("Relay team")
  await dialog.getByLabel("Parent folder", { exact: true }).fill("/tmp/societies")

  const request = societyCreate(page)
  await dialog.getByRole("button", { name: "Create team", exact: true }).click()
  expect((await request).postDataJSON()).toEqual({
    goal: "Ship the relay",
    team: "system",
    name: "Relay team",
    directory: "/tmp/societies",
  })
  await expect(dialog).toHaveCount(0)
})

test("Home shows the projects of the AI team it just created", async ({ page }) => {
  await openHome(page)
  await page.locator('[data-action="home-create-ai-team"]').click()

  const dialog = page.getByRole("dialog")
  await dialog.getByLabel("Goal", { exact: true }).fill("Ship the relay")
  await dialog.getByRole("button", { name: "Create team", exact: true }).click()
  await expect(dialog).toHaveCount(0)

  // The chat opens on its own; Home then lists the projects the Society's group names, not just the chat's folder.
  await expect(page).toHaveURL(/\/session\/ses_mock_society$/)
  await page.getByRole("button", { name: "Home" }).click()
  await expect(page).toHaveURL("/")

  const rows = page.locator('[data-component="home-project-row"]')
  await expect(rows.filter({ hasText: "whole-system" })).toBeVisible()
  await expect(rows.filter({ hasText: "society" })).toBeVisible()
})

test("an empty Home offers the AI team before Add project", async ({ page }) => {
  await mockStressTimeline(page, { fileList: () => [] })
  await seed(page, { storage: { "opencode.global.dat:server": { projects: { local: [] } } } })
  await page.goto("/")

  await expect(
    page.locator('[data-action="home-create-ai-team-row"], [data-action="home-add-project-row"]'),
  ).toHaveText(["Create AI team", "Add project"])
})

test("the project menu keeps Import session and Edit project in a submenu", async ({ page }) => {
  await openHome(page)
  const project = page.locator('[data-component="home-project-row"]').filter({ hasText: fixture.project.name })
  await expect(project).toBeVisible()
  await project.locator("..").getByRole("button", { name: "More options", exact: true }).click()

  const menu = page.getByRole("menu")
  await expect(menu.getByRole("menuitem", { name: "Edit project", exact: true })).toHaveCount(0)
  await expect(menu.getByRole("menuitem", { name: "Import session", exact: true })).toHaveCount(0)
  await menu.getByRole("menuitem", { name: "More", exact: true }).hover()
  await expect(page.getByRole("menuitem", { name: "Edit project", exact: true })).toBeVisible()
})

test("picking a known project's own folder opens that project without a path choice", async ({ page }) => {
  await mockStressTimeline(page, { fileList: () => [] })
  await seed(page, { projects: { local: [{ worktree: fixture.directory, expanded: true }] } })
  await page.goto("/")

  await page.getByRole("button", { name: "Add project", exact: true }).click()
  const picker = page.getByRole("dialog", { name: "Open project", exact: true })
  const select = picker.getByRole("button", { name: "Select folder", exact: true })
  // The picker starts at the server's location, which is this project's root.
  await expect(select).toBeEnabled()
  await select.click()

  const project = page.locator('[data-component="home-project-row"]').filter({ hasText: fixture.project.name })
  await expect(project).toHaveAttribute("data-selected", "")
  await expect(page.getByRole("dialog", { name: "Projects found at this path", exact: true })).toHaveCount(0)
})
