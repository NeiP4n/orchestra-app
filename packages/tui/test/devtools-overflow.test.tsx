import { expect, test } from "bun:test"
import { createAppFixture } from "./fixture/app"
import { directory, json } from "./fixture/tui-client"
import { tmpdir } from "./fixture/fixture"

async function bar(width: number) {
  await using state = await tmpdir()
  await using setup = await createAppFixture({
    width,
    height: 30,
    state: state.path,
    config: { animations: false, debug: { devtools: true } },
    fetch: (url) => {
      if (url.pathname === "/api/orchestra/project") return json([{ id: "prj_demo", name: "Demo", directory, created: 0 }])
      if (url.pathname === "/api/room/mesh" || url.pathname.endsWith("/session")) return json([])
    },
  })
  await setup.ready
  await setup.waitForFrame((frame) => frame.includes("Server"))
  const frame = setup.captureCharFrame()
  return frame.split("\n").find((line) => line.includes("Server")) ?? ""
}

// A phone-width terminal folds items away; the overflow mark keeps them reachable instead of silently dropping them.
test("the bar shows the overflow mark only when something had to fold away", async () => {
  expect(await bar(150)).not.toContain("⋯")
  const narrow = await bar(70)
  expect(narrow).toContain("⋯")
  expect(narrow).toContain("Server")
})

test("the overflow mark opens the command palette", async () => {
  await using state = await tmpdir()
  await using setup = await createAppFixture({
    width: 70,
    height: 30,
    state: state.path,
    config: { animations: false, debug: { devtools: true } },
    fetch: (url) => {
      if (url.pathname === "/api/orchestra/project") return json([{ id: "prj_demo", name: "Demo", directory, created: 0 }])
      if (url.pathname === "/api/room/mesh" || url.pathname.endsWith("/session")) return json([])
    },
  })
  await setup.ready
  await setup.waitForFrame((frame) => frame.includes("⋯"))
  const lines = setup.captureCharFrame().split("\n")
  const y = lines.findIndex((line) => line.includes("⋯"))
  await setup.mockMouse.click(lines[y]!.indexOf("⋯"), y)
  await setup.waitForFrame((frame) => frame.toLowerCase().includes("command") || frame.includes("Команды"))
})
