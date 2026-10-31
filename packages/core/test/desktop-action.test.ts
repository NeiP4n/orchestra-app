import { describe, expect, test } from "bun:test"
import {
  buildScript,
  LIMIT,
  MEDIA_KEY,
  mediaLibraryReady,
  parseResult,
  pressVirtualKey,
  renderMedia,
  renderResult,
  validate,
  type Input,
} from "@orchestra/core/tool/plugin/desktop-action"

const input = (patch: Partial<Input>): Input => ({ action: "click", ...patch })

const rawResult = (patch: Record<string, unknown> = {}) =>
  JSON.stringify({
    action: "invoke",
    method: "InvokePattern",
    window: { title: "Калькулятор", processId: 4242, process: "CalculatorApp", x: 100, y: 100, w: 400, h: 600 },
    element: { name: "Семь", type: "Button", automationId: "num7Button", x: 120, y: 400, w: 80, h: 60 },
    point: null,
    ...patch,
  })

describe("desktop_action validation", () => {
  test("type needs text and media needs a command", () => {
    expect(validate(input({ action: "type", text: "" }))).toContain("needs the text")
    expect(validate(input({ action: "type" }))).toContain("needs the text")
    expect(validate(input({ action: "media" }))).toContain("needs a command")
  })

  test("click, invoke and focus accept an omitted target, and a well-formed call passes", () => {
    expect(validate(input({ action: "click" }))).toBeUndefined()
    expect(validate(input({ action: "invoke", target: "Save" }))).toBeUndefined()
    expect(validate(input({ action: "focus" }))).toBeUndefined()
    expect(validate(input({ action: "type", target: "Search", text: "hello" }))).toBeUndefined()
    expect(validate(input({ action: "media", command: "mute" }))).toBeUndefined()
  })
})

describe("desktop_action script", () => {
  test("carries the action, window, target and text as PowerShell string literals", () => {
    expect(buildScript(input({ action: "invoke", app: "Calc", target: "num7Button" }))).toBe(
      "Invoke-Action -Action 'invoke' -App 'Calc' -Target 'num7Button' -Text ''",
    )
    expect(buildScript(input({ action: "type", target: "Search", text: "hello world" }))).toBe(
      "Invoke-Action -Action 'type' -App '' -Target 'Search' -Text 'hello world'",
    )
  })

  test("a quote or a newline in a name cannot end the PowerShell argument", () => {
    expect(buildScript(input({ action: "invoke", target: "Save'me" }))).toContain("-Target 'Save''me'")

    const text = "line\n'; Remove-Item C:\\ -Force; '"
    const script = buildScript(input({ action: "type", target: "Field", text }))
    const literal = script.slice(script.indexOf("-Text ") + "-Text ".length)
    const unwrapped = literal.slice(1, -1).replaceAll("''", "'")

    expect(literal.startsWith("'")).toBe(true)
    expect(literal.endsWith("'")).toBe(true)
    expect(unwrapped).toBe(text)
  })

  test("whitespace around app and target is trimmed", () => {
    expect(buildScript(input({ action: "focus", app: "  Calculator  ", target: " Save " }))).toBe(
      "Invoke-Action -Action 'focus' -App 'Calculator' -Target 'Save' -Text ''",
    )
  })
})

describe("desktop_action result", () => {
  test("parses the window, the element and the click point", () => {
    const result = parseResult(rawResult({ action: "click", method: "Mouse", point: { x: 160, y: 430 } }))

    expect(result.action).toBe("click")
    expect(result.method).toBe("Mouse")
    expect(result.window).toEqual({
      title: "Калькулятор",
      processId: 4242,
      process: "CalculatorApp",
      x: 100,
      y: 100,
      w: 400,
      h: 600,
    })
    expect(result.element).toMatchObject({ name: "Семь", type: "Button", automationId: "num7Button", w: 80, h: 60 })
    expect(result.point).toEqual({ x: 160, y: 430 })
  })

  test("a null point, a missing name or id is not a broken shape", () => {
    const result = parseResult(
      rawResult({
        element: { name: null, type: null, automationId: null, x: 1, y: 2, w: 3, h: 4 },
        window: { title: null, processId: 7, process: null, x: 0, y: 0, w: 10, h: 10 },
      }),
    )

    expect(result.element).toEqual({ name: "", type: "", automationId: "", x: 1, y: 2, w: 3, h: 4 })
    expect(result.window.process).toBe("")
    expect(result.point).toBeUndefined()
  })

  test("text that is not a result fails loudly", () => {
    expect(() => parseResult("")).toThrow()
    expect(() => parseResult("<html>")).toThrow()
    expect(() => parseResult('{"action":"click","method":"Mouse"}')).toThrow()
  })
})

describe("desktop_action rendering", () => {
  test("click reports the element, the window and the point it hit", () => {
    const text = renderResult(parseResult(rawResult({ action: "click", method: "Mouse", point: { x: 160, y: 430 } })))

    expect(text).toContain('clicked "Семь" (Button) in "Калькулятор" [CalculatorApp 4242] @ 160,430 (Mouse)')
  })

  test("a click without a target reports the centre of the window", () => {
    const text = renderResult(
      parseResult(
        rawResult({
          action: "click",
          point: { x: 300, y: 400 },
          element: { name: "Калькулятор", type: "Window", automationId: "", x: 100, y: 100, w: 400, h: 600 },
        }),
      ),
    )
    expect(text).toContain('clicked "Калькулятор" (Window)')
  })

  test("invoke, focus and type name the pattern that did the work", () => {
    expect(renderResult(parseResult(rawResult()))).toContain(
      'invoked "Семь" (Button) in "Калькулятор" [CalculatorApp 4242] via InvokePattern.',
    )
    expect(renderResult(parseResult(rawResult({ action: "focus", method: "SetFocus" })))).toContain("focused")
    expect(renderResult(parseResult(rawResult({ action: "type", method: "ValuePattern" })))).toContain(
      "via ValuePattern",
    )
  })

  test("an unnamed element falls back to its automation id", () => {
    const text = renderResult(
      parseResult(
        rawResult({ element: { name: "", type: "Edit", automationId: "searchBox", x: 0, y: 0, w: 10, h: 10 } }),
      ),
    )
    expect(text).toContain('"searchBox" (Edit)')
  })

  test("a long answer stays inside the context budget", () => {
    const text = renderResult(
      parseResult(
        rawResult({ window: { title: "W".repeat(4000), processId: 1, process: "p", x: 0, y: 0, w: 1, h: 1 } }),
      ),
    )
    expect(text.length).toBeLessThanOrEqual(LIMIT)
  })
})

describe("desktop_action media keys", () => {
  test("every command maps to its Windows virtual-key code", () => {
    expect(MEDIA_KEY.play_pause).toBe(0xb3)
    expect(MEDIA_KEY.play).toBe(0xb3)
    expect(MEDIA_KEY.pause).toBe(0xb3)
    expect(MEDIA_KEY.next).toBe(0xb0)
    expect(MEDIA_KEY.prev).toBe(0xb1)
    expect(MEDIA_KEY.mute).toBe(0xad)
  })

  test("the answer names the key code and the one play/pause toggle", () => {
    expect(renderMedia("next")).toBe("sent media next as VK 0xB0.")
    expect(renderMedia("mute")).toBe("sent media mute as VK 0xAD.")
    expect(renderMedia("play")).toContain("one play/pause toggle")
  })

  test("user32.dll really exposes keybd_event, and a harmless key code can be sent through it", () => {
    if (process.platform !== "win32") {
      expect(mediaLibraryReady()).toBe(false)
      return
    }
    expect(mediaLibraryReady()).toBe(true)
    // VK 0x00 is undefined, so this proves the FFI call works without pressing a real media key.
    expect(() => pressVirtualKey(0x00)).not.toThrow()
  })
})
