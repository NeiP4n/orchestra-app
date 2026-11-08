import { afterEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { DesktopTool } from "@orchestra/core/tool/plugin/desktop"
import { buildScript, renderResult, parseResult, validate } from "@orchestra/core/tool/plugin/desktop-action"

// ADR-4: on Windows the agent never moves or presses the operator's real pointer.
const plugin = path.join(import.meta.dir, "../src/tool/plugin")
const desktopSource = readFileSync(path.join(plugin, "desktop.ts"), "utf8")
const actionSource = readFileSync(path.join(plugin, "desktop-action.ts"), "utf8")

const original = process.platform
const setPlatform = (value: string) => Object.defineProperty(process, "platform", { value, configurable: true })
afterEach(() => setPlatform(original))

const recorder = () => {
  const calls: string[] = []
  const host = {
    call: async (script: string) => {
      calls.push(script)
      return ""
    },
  } as unknown as Parameters<typeof DesktopTool.run>[0]
  return { calls, host }
}

describe("no pointer on Windows: source", () => {
  test("neither desktop tool declares or calls a mouse or cursor-position API", () => {
    for (const source of [desktopSource, actionSource]) {
      expect(source).not.toContain("SetCursorPos")
      expect(source).not.toContain("mouse_event")
      expect(source).not.toMatch(/MOUSEEVENTF|MOUSEINPUT/)
    }
  })

  test("the action helper has no Send-Click, Click-Element, clipboard paste or forced foreground", () => {
    for (const word of [
      "Send-Click",
      "Click-Element",
      "Paste-Text",
      "Force-Foreground",
      "Set-Clipboard",
      "Get-Clipboard",
    ]) {
      expect(actionSource).not.toContain(word)
    }
  })

  test("Activate-Window runs only for the focus action", () => {
    expect(actionSource).toContain("if ($Action -eq 'focus') { Activate-Window $window }")
    expect(actionSource.match(/Activate-Window \$window/g)?.length).toBe(2)
  })
})

describe("no pointer on Windows: desktop steps", () => {
  test("click, hover and scroll are refused with a helpful message and reach no host script", async () => {
    setPlatform("win32")
    const { calls, host } = recorder()
    for (const step of [
      { action: "click", x: 10, y: 20 },
      { action: "click" },
      { action: "move", x: 10, y: 20 },
      { action: "scroll", amount: 3 },
      { action: "scroll", amount: -2, x: 5, y: 5 },
    ] as const) {
      await expect(DesktopTool.run(host, step, undefined)).rejects.toThrow(/real mouse pointer/)
    }
    expect(calls).toEqual([])
  })

  test("the refusal names the pointer-free alternatives", () => {
    expect(DesktopTool.pointerRefusal("click")).toContain("desktop_action")
    expect(DesktopTool.pointerRefusal("scroll")).toContain('action "scroll"')
    expect(DesktopTool.pointerRefusal("hover")).toContain("browser")
  })

  test("long text on Windows is typed, never pasted through the clipboard", async () => {
    setPlatform("win32")
    const { calls, host } = recorder()
    await DesktopTool.run(host, { action: "type", text: "x".repeat(200) }, undefined)
    await DesktopTool.run(host, { action: "type", text: "short", paste: true }, undefined)
    expect(calls).toHaveLength(2)
    for (const script of calls) {
      expect(script).toContain("SendKeys")
      expect(script).not.toContain("Clipboard")
      expect(script).not.toContain("^v")
    }
  })

  test("other platforms keep their own click path", async () => {
    setPlatform("linux")
    const { calls, host } = recorder()
    await DesktopTool.run(host, { action: "click", x: 1, y: 2 }, undefined)
    expect(calls[0]).toContain("click")
  })
})

describe("no pointer on Windows: desktop_action", () => {
  test("the scroll action is accepted and carries its direction", () => {
    expect(validate({ action: "scroll", target: "List", direction: "down" })).toBeUndefined()
    expect(buildScript({ action: "scroll", target: "List", direction: "down" })).toContain("-Direction 'down'")
    expect(buildScript({ action: "click", target: "OK" })).not.toContain("-Direction")
  })

  test("click tries the Invoke, Toggle or Select patterns and refuses instead of using the mouse", () => {
    expect(actionSource).toContain("$method = Invoke-Element $element")
    expect(actionSource).toContain("needs the real mouse pointer")
    expect(actionSource).toContain("click needs a target")
  })

  test("typing without a writable field is refused, not pasted", () => {
    expect(actionSource).toContain("has no writable ValuePattern")
  })

  test("a pattern click and a scroll render their method", () => {
    const base = {
      method: "InvokePattern",
      window: { title: "Calc", processId: 1, process: "calc", x: 0, y: 0, w: 1, h: 1 },
      element: { name: "OK", type: "Button", automationId: "", x: 0, y: 0, w: 1, h: 1 },
    }
    const clicked = renderResult(parseResult(JSON.stringify({ action: "click", ...base })))
    expect(clicked).toContain('clicked "OK" (Button)')
    expect(clicked).toContain("via InvokePattern")
    const scrolled = renderResult(parseResult(JSON.stringify({ action: "scroll", ...base, method: "ScrollPattern" })))
    expect(scrolled).toContain("scrolled")
    expect(scrolled).toContain("via ScrollPattern")
  })
})
