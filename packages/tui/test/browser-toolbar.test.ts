import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { ruContext } from "../src/util/i18n-context"

test("browser toolbar combines resources with actions and navigation with scrollable tabs", () => {
  const source = readFileSync(new URL("../src/component/browser-pane.tsx", import.meta.url), "utf8")
  const start = source.indexOf('<box id="browser.toolbar"')
  const end = source.indexOf('<Show when={view() === "text" && mode() === "headless"}>', start)
  const header = source.slice(start, end)
  expect(header).toContain("{resourceLabel()}")
  expect(header).toContain('id="browser.navigation"')
  expect(header).toContain('id="browser.tabs"')
  expect(header).toContain('scrollX={true} scrollY={false}')
  expect(header).toContain('horizontalScrollbarOptions={{ visible: false }}')
  expect(header).toContain('verticalScrollbarOptions={{ visible: false }}')
  expect(header).toContain('contentOptions={{ flexDirection: "row" }}')
  expect(header).toContain('height={1}')
  expect(header).toContain('onMouseOver={addressHover.onMouseOver}')
  for (const action of ['BrowserRuntime.history(props.sessionID, -1)', 'BrowserRuntime.history(props.sessionID, 1)', 'BrowserRuntime.reload(props.sessionID)', 'BrowserRuntime.selectTab(props.sessionID, tab.id)', 'BrowserRuntime.closeTab(props.sessionID, tab.id)', 'BrowserRuntime.newTab(props.sessionID)']) {
    expect(header).toContain(`onClick={() => tabAction(() => ${action})}`)
  }
  expect(header).toContain('<Action label="Закрыть" onClick={stop}')
  expect(header).toContain('<NeuronDot energy={0.9}')
})

test("Russian control actions and narrow Tools label are readable translations", () => {
  expect(ruContext.Control).toBe("Управление")
  expect(ruContext["Take control"]).toBe("Управление")
  expect(ruContext["Release ^G"]).toBe("Отпустить ^G")
  expect(ruContext["Tools/MCP"]).toBe("MCP/инстр.")
})
