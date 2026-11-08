import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { ConfigProvider } from "../../../src/config"
import { ThemeProvider, useThemes } from "../../../src/context/theme"
import { getOrchestraTheme } from "../../../src/theme"

function source(color: string) {
  const original = structuredClone(getOrchestraTheme())
  return {
    ...original,
    base: {
      ...original.base,
      background: {
        ...original.base.background,
        base: color,
        raised: { ...original.base.background.raised, base: "$background.base" },
      },
    },
  }
}

test("ThemeProvider fresh selection follows literal override without mutating old view", async () => {
  const first = source("#123456"),
    second = source("#345678")
  const snapshots = structuredClone({ first, second })
  let themes!: ReturnType<typeof useThemes>
  function Probe() {
    themes = useThemes()
    return <text>{themes.selected}</text>
  }
  const app = await testRender(
    () => (
      <ConfigProvider config={createTuiResolvedConfig({ theme: { name: "first", mode: "dark" } })}>
        <ThemeProvider mode="dark" source={{ discover: async () => ({ first, second }) }}>
          <Probe />
        </ThemeProvider>
      </ConfigProvider>
    ),
    { width: 30, height: 4 },
  )
  app.renderer.start()
  try {
    await app.waitForFrame((f) => f.includes("first") && themes.ready)
    const old = themes.current
    const oldColor = old.background.base
    const oldRaised = old.background.raised.base
    const oldBytes = oldColor.toInts()
    expect(old.background.raised.base).toBe(old.background.base)
    expect(themes.set("second")).toBeTrue()
    await app.waitForFrame((f) => f.includes("second"))
    const fresh = themes.current
    expect(fresh.background.base.toInts()).toEqual([52, 86, 120, 255])
    expect(fresh.background.raised.base).toBe(fresh.background.base)
    expect(fresh.background.base).not.toBe(oldColor)
    expect(oldColor.toInts()).toEqual(oldBytes)
    expect(oldRaised).toBe(oldColor)
    expect({ first, second }).toEqual(snapshots)
  } finally {
    app.renderer.destroy()
  }
})
