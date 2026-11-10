import { expect, test } from "bun:test"
import { createAppFixture } from "./fixture/app"
import { directory, json } from "./fixture/tui-client"
import { tmpdir } from "./fixture/fixture"

for (const [language, label, other] of [["en", "⇢ Join", "⇢ Войти"], ["ru", "⇢ Войти", "⇢ Join"]] as const) {
  test(`compact Multiplayer join action follows ${language}`, async () => {
    await using state = await tmpdir()
    await using setup = await createAppFixture({
      state: state.path,
      width: 130,
      height: 30,
      config: { animations: false, language, debug: { devtools: true } },
      fetch: (url) => {
        if (url.pathname === "/api/location")
          return json({ directory, project: { id: "project", directory, canonical: directory } })
        if (url.pathname === "/api/room") return json({ data: [] })
      },
    })
    const frame = await setup.waitForFrame((frame) => frame.includes(label))
    expect(frame).not.toContain(other)
    expect(frame.split("\n").filter((line) => line.includes(label))).toHaveLength(1)
    if (process.env.TEAM_EDITOR_FRAMES)
      await Bun.write(`${process.env.TEAM_EDITOR_FRAMES}/compact-multiplayer-${language}.txt`, frame)
  })
}
