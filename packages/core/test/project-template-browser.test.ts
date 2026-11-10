import { expect, test } from "bun:test"
import { mkdtemp, mkdir, writeFile, rm, symlink, link } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ProjectTemplateBrowser } from "../src/project-template-browser"
import { ProjectTemplateSource } from "../src/project-template-source"
const definition = { id: "brw_a", name: "Inbox", projectID: "prj_a", chat: "ses_a" }
async function fixture(fn: (root: string, directory: string) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "template-browser-"))
  const directory = path.join(root, "browser-profiles")
  try {
    await mkdir(directory)
    await fn(root, directory)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
test("reads all saved URLs only, preserving BrowserAgent binding while excluding page titles and profiles", () =>
  fixture(async (root, directory) => {
    const urls = Array.from({ length: 12 }, (_, i) => `https://example.com/inbox/${i}`)
    await writeFile(
      path.join(directory, "brw_a.tabs.json"),
      JSON.stringify({ tabs: urls.map((url) => ({ url, title: "PRIVATE-CANARY" })), active: urls[2] }),
    )
    await mkdir(path.join(directory, "brw_a"))
    await writeFile(path.join(directory, "brw_a", "Cookies"), "PRIVATE-CANARY")
    const browsers = await ProjectTemplateBrowser.capture(root, "prj_a", [definition])
    expect(browsers[0]).toEqual({ ...definition, mode: "window", savedLinks: urls })
    expect(JSON.stringify(browsers)).not.toContain("PRIVATE-CANARY")
    const snapshot = ProjectTemplateSource.capture(
      {
        project: { id: "prj_a", name: "Factory", main: "ses_a" },
        sessions: [{ id: "ses_a", title: "BrowserAgent", agent: "team-browser-agent" }],
        ownedSessionIDs: new Set(["ses_a"]),
        browsers,
        rules: [],
        schedules: [],
        vault: [],
        selectedGlobalSlotIDs: new Set(),
        providers: [],
        mcp: [],
      },
      { name: "Factory", description: "Config", minOrchestraVersion: "1.0.0" },
    )
    expect(snapshot.ok).toBe(true)
    if (snapshot.ok) {
      expect(snapshot.value.bundle.mainSession).toBe("session_1")
      expect(snapshot.value.bundle.browsers[0].session).toBe("session_1")
      expect(snapshot.value.text).not.toContain("ses_a")
    }
  }))
for (const bad of [
  "https://example.com/?q=private",
  "https://example.com/#private",
  "file:///private",
  "https://user:password@example.com/",
])
  test("unsafe saved URL fails without silently stripping parameters", () =>
    fixture(async (root, directory) => {
      await writeFile(path.join(directory, "brw_a.tabs.json"), JSON.stringify([bad]))
      await expect(ProjectTemplateBrowser.capture(root, "prj_a", [definition])).rejects.toThrow()
    }))
test("wrong owner, links/hardlinks, malformed or too many saved tabs fail closed", () =>
  fixture(async (root, directory) => {
    await expect(ProjectTemplateBrowser.capture(root, "prj_b", [definition])).rejects.toThrow()
    const source = path.join(root, "source")
    await writeFile(source, JSON.stringify(["https://example.com"]))
    const target = path.join(directory, "brw_a.tabs.json")
    await symlink(source, target)
    await expect(ProjectTemplateBrowser.capture(root, "prj_a", [definition])).rejects.toThrow()
    await rm(target)
    await link(source, target)
    await expect(ProjectTemplateBrowser.capture(root, "prj_a", [definition])).rejects.toThrow()
    await rm(target)
    await writeFile(target, JSON.stringify(Array(101).fill("https://example.com")))
    await expect(ProjectTemplateBrowser.capture(root, "prj_a", [definition])).rejects.toThrow()
    await writeFile(target, "not JSON")
    await expect(ProjectTemplateBrowser.capture(root, "prj_a", [definition])).rejects.toThrow()
  }))
test("unopened sessions stay unopened with no links, and linked profile directories are refused", () =>
  fixture(async (root, directory) => {
    expect((await ProjectTemplateBrowser.capture(root, "prj_a", [definition]))[0].savedLinks).toEqual([])
    await rm(directory, { recursive: true })
    await symlink(root, directory)
    await expect(ProjectTemplateBrowser.capture(root, "prj_a", [definition])).rejects.toThrow()
  }))
