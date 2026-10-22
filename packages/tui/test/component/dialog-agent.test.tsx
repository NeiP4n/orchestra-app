import { expect, test } from "bun:test"
import { CliRenderEvents, InputRenderable } from "@opentui/core"
import { once } from "node:events"
import { agentOptions, DialogAgent } from "../../src/component/dialog-agent"
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
