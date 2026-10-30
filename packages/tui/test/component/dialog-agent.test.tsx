import { expect, test } from "bun:test"
import { CliRenderEvents, InputRenderable, RGBA } from "@opentui/core"
import { once } from "node:events"
import { agentOptions, DialogAgent } from "../../src/component/dialog-agent"
import { PromptMetadataRow } from "../../src/component/prompt/metadata"
import { agent, renderLocal } from "../fixture/local"
import { json } from "../fixture/tui-client"

const roles = [
  { agent: "team-architect", name: "Architect", description: "Plans", category: "Planning" },
  { agent: "team-developer", name: "Developer", description: "Builds", category: "Build" },
  { agent: "team-tester", name: "Tester", description: "Tests", category: "Quality" },
]

test("agent panel puts own agents first and groups roles by category", () => {
  const options = agentOptions(
    [
      { id: "team-tester", name: "Tester" },
      { id: "build", name: "build" },
      { id: "team-developer", name: "Developer" },
      { id: "team-custom", name: "Custom" },
      { id: "team-architect", name: "Architect" },
      { id: "LeadSpark", name: "LeadSpark" },
    ],
    roles as never,
  )
  expect(options.map((option) => [option.category, option.value])).toEqual([
    ["Agents", "build"],
    ["Agents", "LeadSpark"],
    ["Planning", "team-architect"],
    ["Build", "team-developer"],
    ["Quality", "team-tester"],
    ["Team roles", "team-custom"],
  ])
})

test("clicking the agent label opens the categorized panel and keeps it open", async () => {
  let opened: (() => void) | undefined
  await using setup = await renderLocal({
    agents: [agent("build"), agent("team-architect"), agent("team-developer")],
    fetch: (url) => (url.pathname === "/api/orchestra/role" ? json(roles) : undefined),
    view: () => (
      // The real prompt footer row, pinned to the bottom like the composer's.
      <box position="absolute" left={2} top={28} width={60}>
        <PromptMetadataRow
          mode="normal"
          agent="Build"
          auto={false}
          model="model"
          provider="provider"
          muted={false}
          highlight={RGBA.fromHex("#00ffff")}
          agentAlpha={1}
          modelAlpha={1}
          variantAlpha={1}
          onAgentClick={() => opened?.()}
        />
      </box>
    ),
  })
  opened = () => setup.dialog.replace(() => <DialogAgent />)
  await setup.renderOnce()
  await setup.mockMouse.click(3, 28)
  const frame = await setup.waitForFrame((frame) => frame.includes("Planning"))
  expect(frame).toContain("Agents")
  await Bun.sleep(200)
  await setup.renderOnce()
  expect(setup.dialog.stack.length).toBe(1)
  expect(setup.captureCharFrame()).toContain("Planning")
})

test("the release of the opening click does not pick the row under it, a real click does", async () => {
  await using setup = await renderLocal({
    agents: [agent("build"), agent("team-architect"), agent("team-developer")],
    fetch: (url) => (url.pathname === "/api/orchestra/role" ? json(roles) : undefined),
  })
  setup.dialog.replace(() => <DialogAgent />)
  const frame = await setup.waitForFrame((frame) => frame.includes("Architect"))
  const lines = frame.split("\n")
  const y = lines.findIndex((line) => line.includes("Architect"))
  const x = lines[y].indexOf("Architect")
  await setup.mockMouse.release(x, y)
  await setup.renderOnce()
  expect(setup.dialog.stack.length).toBe(1)
  expect(setup.local.agent.current()?.id).toBe("build")
  await setup.mockMouse.click(x, y)
  await setup.waitFor(() => setup.dialog.stack.length === 0)
  expect(setup.local.agent.current()?.id).toBe("team-architect")
})

test("a rail of categories with counts filters the panel, like Settings", async () => {
  await using setup = await renderLocal({
    agents: [agent("build"), agent("team-architect"), agent("team-developer"), agent("team-tester")],
    fetch: (url) => (url.pathname === "/api/orchestra/role" ? json(roles) : undefined),
  })
  setup.dialog.replace(() => <DialogAgent />)
  const frame = await setup.waitForFrame((frame) => frame.includes("Architect") && frame.includes("Tester"))
  // Every category is listed in the rail, each with how many agents it holds.
  expect(frame).toMatch(/All\s+4/)
  expect(frame).toMatch(/Planning\s+1/)
  expect(frame).toMatch(/Quality\s+1/)
  expect(setup.dialog.size).toBe("large")

  // Click "Quality" in the rail: only its agents stay.
  const lines = frame.split("\n")
  const row = lines.findIndex((line) => /Quality\s+1/.test(line))
  await setup.mockMouse.click(lines[row].indexOf("Quality") + 1, row)
  const filtered = await setup.waitForFrame((next) => !next.includes("Architect") && next.includes("Tester"))
  expect(filtered).not.toContain("Developer")
  expect(setup.dialog.stack.length).toBe(1)
})

test("shift+tab walks the agent panel and enter switches", async () => {
  await using setup = await renderLocal({
    agents: [agent("build"), agent("team-architect"), agent("team-developer")],
    fetch: (url) => (url.pathname === "/api/orchestra/role" ? json(roles) : undefined),
  })
  expect(setup.local.agent.current()?.id).toBe("build")
  setup.dialog.replace(() => <DialogAgent />)
  await setup.waitForFrame((frame) => frame.includes("Planning") && frame.includes("Build"))
  // The dialog paints before its deferred filter focus is ready for keys.
  if (!(setup.renderer.currentFocusedRenderable instanceof InputRenderable))
    await once(setup.renderer, CliRenderEvents.FOCUSED_RENDERABLE)
  setup.mockInput.pressKey("TAB", { shift: true })
  await setup.renderOnce()
  setup.mockInput.pressEnter()
  await setup.waitFor(() => setup.dialog.stack.length === 0)
  expect(setup.local.agent.current()?.id).toBe("team-architect")
})
