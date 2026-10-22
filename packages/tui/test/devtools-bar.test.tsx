import { expect, test } from "bun:test"
import { createAppFixture } from "./fixture/app"
import { directory, json } from "./fixture/tui-client"
import { tmpdir } from "./fixture/fixture"

// Regression: with a project present the "+ Project" item is hidden, and once a panel had
// closed, the backdrop that closes panels sorted above the open panel and took its clicks.
test("devtools panel actions take clicks after a panel was closed while a project exists", async () => {
  await using state = await tmpdir()
  await using setup = await createAppFixture({
    width: 150,
    height: 34,
    state: state.path,
    config: { animations: false, debug: { devtools: true } },
    fetch: (url) => {
      if (url.pathname === "/api/orchestra/project")
        return json([{ id: "prj_demo", name: "Demo", directory, created: 0 }])
    },
  })
  await setup.ready
  await setup.waitForFrame((frame) => frame.includes("Tools") && frame.includes("Demo") && !frame.includes("+ Project"))
  expect(setup.captureCharFrame()).not.toContain("Layout")
  const find = (text: string) => {
    const lines = setup.captureCharFrame().split("\n")
    const y = lines.findIndex((line) => line.includes(text))
    return { x: lines[y]!.indexOf(text), y }
  }
  // Opening and closing panels re-sorts the bar; this order put the backdrop above the panel.
  for (const [item, title] of [[" UI ", "Loop"], [" Theme ", "Mode"]] as const) {
    const at = find(item)
    await setup.mockMouse.click(at.x + 2, at.y)
    await setup.waitForFrame((frame) => frame.includes(title))
    setup.mockInput.pressEscape()
    await setup.waitForFrame((frame) => !frame.includes(title))
  }

  const tools = find(" Tools ")
  await setup.mockMouse.click(tools.x + 2, tools.y)
  await setup.waitForFrame((frame) => frame.includes("[ ] Time to first draw"))
  const item = find("[ ] Time to first draw")
  await setup.mockMouse.click(item.x + 4, item.y)
  await setup.waitForFrame((frame) => frame.includes("[x] Time to first draw"))
  expect(setup.captureCharFrame()).toContain("Write debug snapshot")
})

test("home side panels collapse and restore from their own edge controls", async () => {
  await using state = await tmpdir()
  await using setup = await createAppFixture({
    width: 150,
    height: 34,
    state: state.path,
    config: { animations: false, debug: { devtools: true } },
    fetch: (url) => {
      if (url.pathname === "/api/orchestra/project")
        return json([{ id: "prj_demo", name: "Demo", directory, created: 0 }])
    },
  })
  await setup.ready
  await setup.waitForFrame((frame) => frame.includes("Project DoD") && frame.includes("Multiplayer"))

  const clickGlyphOnLine = async (needle: string, glyph: string, rightmost = false) => {
    const lines = setup.captureCharFrame().split("\n")
    const lineIndex = lines.findIndex((line) => line.includes(needle))
    if (lineIndex < 0) throw new Error(`no ${needle} on screen`)
    const x = rightmost ? lines[lineIndex]!.lastIndexOf(glyph) : lines[lineIndex]!.indexOf(glyph)
    if (x < 0) throw new Error(`no ${glyph} on the line with ${needle}`)
    await setup.mockMouse.click(x, lineIndex)
  }

  const glyphAtEdge = (glyph: string, edge: "left" | "right") => {
    const lines = setup.captureCharFrame().split("\n")
    let found: { x: number; y: number } | undefined
    for (let y = 0; y < lines.length; y++) {
      let x = lines[y]!.indexOf(glyph)
      while (x >= 0) {
        if (!found || (edge === "left" ? x < found.x : x > found.x)) found = { x, y }
        x = lines[y]!.indexOf(glyph, x + glyph.length)
      }
    }
    if (!found) throw new Error(`no ${glyph} rail on the ${edge}`)
    return found
  }

  await clickGlyphOnLine("Projects", "‹", true)
  await setup.waitForFrame((frame) => !frame.includes("Multiplayer") && frame.includes("Project DoD"))
  const leftRail = glyphAtEdge("›", "left")
  await setup.mockMouse.click(leftRail.x, leftRail.y)
  await setup.waitForFrame((frame) => frame.includes("Multiplayer") && frame.includes("Project DoD"))

  const homeHide = glyphAtEdge("›", "right")
  await setup.mockMouse.click(homeHide.x, homeHide.y)
  await setup.waitForFrame((frame) => !frame.includes("Project DoD"))
  const rightRail = glyphAtEdge("‹", "right")
  await setup.mockMouse.click(rightRail.x, rightRail.y)
  await setup.waitForFrame((frame) => frame.includes("Project DoD"))
})
