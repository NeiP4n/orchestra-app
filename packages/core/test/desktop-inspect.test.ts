import { describe, expect, test } from "bun:test"
import {
  buildScript,
  DEFAULT_LIMIT,
  LIMIT,
  MAX_LIMIT,
  parseReport,
  renderReport,
  UNSUPPORTED,
} from "@orchestra/core/tool/plugin/desktop-inspect"

const button = (name: string, x: number, y: number, w = 80, h = 24) => ({
  name,
  type: "Button",
  automationId: "",
  x,
  y,
  w,
  h,
  enabled: true,
})

const focusedReport = () =>
  JSON.stringify({
    action: "focused",
    query: "",
    window: { title: "Untitled - Notepad", processId: 4242, class: "Notepad", x: 100, y: 100, w: 800, h: 600 },
    windows: [],
    elements: [
      { name: "Save", type: "Button", automationId: "save", x: 700, y: 30, w: 81, h: 25, enabled: true },
      { name: null, type: "Edit", automationId: null, x: 10, y: 50, w: 100, h: 20, enabled: null },
    ],
    truncated: false,
    scanned: 321,
  })

describe("desktop_inspect report", () => {
  test("parses the window and every control", () => {
    const report = parseReport(focusedReport())

    expect(report.action).toBe("focused")
    expect(report.window?.title).toBe("Untitled - Notepad")
    expect(report.window?.processId).toBe(4242)
    expect(report.elements).toHaveLength(2)
    expect(report.scanned).toBe(321)
    expect(report.truncated).toBe(false)
  })

  test("coordinates are the centre of the control, rounded to whole pixels", () => {
    const report = parseReport(focusedReport())

    expect(report.elements[0]).toMatchObject({ name: "Save", type: "Button", centerX: 741, centerY: 43, w: 81, h: 25 })
    expect(report.elements[1]).toMatchObject({ centerX: 60, centerY: 60, w: 100, h: 20 })
  })

  test("a missing name, id or state becomes an empty value, not a broken shape", () => {
    const element = parseReport(focusedReport()).elements[1]

    expect(element?.name).toBe("")
    expect(element?.automationId).toBe("")
    expect(element?.enabled).toBe(true)
  })

  test("an empty answer the helper can print is not an error", () => {
    const empty = JSON.stringify({ action: "focused", query: "", window: null, windows: null, elements: null })
    const report = parseReport(empty)

    expect(report.window).toBeUndefined()
    expect(report.elements).toEqual([])
    expect(report.windows).toEqual([])
    expect(report.scanned).toBe(0)
  })

  test("text that is not a report fails loudly", () => {
    expect(() => parseReport("")).toThrow()
    expect(() => parseReport("<html>no</html>")).toThrow()
    expect(() => parseReport('{"action":"focused","elements":"nope"}')).toThrow()
  })
})

describe("desktop_inspect rendering", () => {
  test("focused shows the window, the count and a click point per control", () => {
    const text = renderReport(parseReport(focusedReport()))

    expect(text).toContain('focused "Untitled - Notepad" [pid 4242] at 100,100 800x600')
    expect(text).toContain("2 interactive control(s):")
    expect(text).toContain("Save  (Button)  @ 741,43  81x25")
    expect(text).toContain("(unnamed)  (Edit)  @ 60,60  100x20")
  })

  test("a window without controls says so", () => {
    const empty = JSON.stringify({
      action: "focused",
      window: { title: "Blender", processId: 9, class: "Blender", x: 0, y: 0, w: 1920, h: 1080 },
      elements: [],
      scanned: 1200,
    })
    expect(renderReport(parseReport(empty))).toBe("No interactive controls in the focused window.")
  })

  test("screen lists windows and their controls", () => {
    const screen = JSON.stringify({
      action: "screen",
      query: "",
      windows: [
        {
          title: "Notepad",
          processId: 1,
          class: "Notepad",
          x: 0,
          y: 0,
          w: 800,
          h: 600,
          elements: [button("Save", 700, 30)],
        },
        { title: "Clock", processId: 2, class: "Clock", x: 0, y: 0, w: 10, h: 10, elements: [] },
      ],
      elements: [],
      scanned: 44,
    })

    const text = renderReport(parseReport(screen))
    expect(text).toContain("2 window(s):")
    expect(text).toContain('"Notepad" [pid 1] at 0,0 800x600')
    expect(text).toContain("    Save  (Button)  @ 740,42  80x24")
    expect(text).toContain("    (no interactive controls)")
  })

  test("find reports a match with its click point and a miss by name", () => {
    const found = JSON.stringify({
      action: "find",
      query: "Save",
      window: null,
      windows: [],
      elements: [button("Save as", 200, 60)],
      scanned: 90,
    })
    expect(renderReport(parseReport(found))).toContain('1 match(es) for "Save":')
    expect(renderReport(parseReport(found))).toContain("Save as  (Button)  @ 240,72  80x24")

    const missing = JSON.stringify({
      action: "find",
      query: "Nonexistent",
      window: null,
      windows: [],
      elements: [],
      scanned: 90,
    })
    expect(renderReport(parseReport(missing))).toBe('No element matches "Nonexistent".')
  })

  test("a miss that ran out of budget says so instead of claiming the element does not exist", () => {
    const cut = JSON.stringify({
      action: "find",
      query: "Save",
      window: null,
      windows: [],
      elements: [],
      truncated: true,
      scanned: 1500,
    })
    const text = renderReport(parseReport(cut))

    expect(text).toContain('No element matches "Save"')
    expect(text).toContain("1500 element(s)")
    expect(text).toContain("time budget")
  })

  test("a long answer stays inside the context budget", () => {
    const many = Array.from({ length: 200 }, (_, index) => button(`Button number ${index}`, index, index * 2))
    const text = renderReport(
      parseReport(
        JSON.stringify({
          action: "focused",
          window: { title: "Big", processId: 1, class: "", x: 0, y: 0, w: 1920, h: 1080 },
          elements: many,
          scanned: 5000,
          truncated: true,
        }),
      ),
    )

    expect(text.length).toBeLessThanOrEqual(LIMIT)
    expect(text).toContain("(truncated)")
  })

  test("a platform without UI Automation gets a clear status, not an empty answer", () => {
    expect(UNSUPPORTED).toContain("Windows")
    expect(UNSUPPORTED).toContain("desktop_screenshot")
  })
})

describe("desktop_inspect script", () => {
  test("builds one PowerShell step that carries the action, the query and the limit", () => {
    expect(buildScript("focused", "", DEFAULT_LIMIT)).toBe("Invoke-Inspect -Action 'focused' -Query '' -Limit 40")
    expect(buildScript("screen", "", 10)).toBe("Invoke-Inspect -Action 'screen' -Query '' -Limit 10")
  })

  test("a quote in a control name cannot break out of the PowerShell string", () => {
    expect(buildScript("find", "Save'me", 5)).toBe("Invoke-Inspect -Action 'find' -Query 'Save''me' -Limit 5")
  })

  test("the limit is clamped to what the helper can walk", () => {
    expect(buildScript("focused", "", 0)).toContain("-Limit 1")
    expect(buildScript("focused", "", 100_000)).toContain(`-Limit ${MAX_LIMIT}`)
    expect(buildScript("focused", "", Number.NaN)).toContain(`-Limit ${DEFAULT_LIMIT}`)
  })
})
