import { describe, expect, test } from "bun:test"
import {
  MAX_SNAPSHOT_CHARS,
  isSnapshotTool,
  isStaleElementError,
  snapshotToolName,
  staleElementMessage,
  timerInEvaluateError,
  timerMessage,
  waitToolName,
} from "../src/tool/mcp-recovery"

describe("isStaleElementError", () => {
  test("matches both chrome-devtools stale-uid errors from the live session", () => {
    expect(isStaleElementError("Error: Element with uid 2_66 no longer exists on the page")).toBe(true)
    expect(isStaleElementError('Error: Element with uid "2_29" not found on page 3')).toBe(true)
  })

  test("matches playwright / agent-desktop stale refs", () => {
    expect(isStaleElementError('Error: Element with ref "e5" not found')).toBe(true)
    expect(isStaleElementError("stale element reference: element is not attached to the page document")).toBe(true)
    expect(isStaleElementError("Element no longer exists")).toBe(true)
    expect(isStaleElementError("STALE_REF: the element changed since the snapshot")).toBe(true)
    expect(isStaleElementError("AMBIGUOUS_TARGET: the ref matches several elements now")).toBe(true)
  })

  test("does not match unrelated failures", () => {
    expect(isStaleElementError("Timeout 30000ms exceeded waiting for element")).toBe(false)
    expect(isStaleElementError("File not found: /tmp/page.html")).toBe(false)
    expect(isStaleElementError("MCP server \"demo\" is not available")).toBe(false)
    expect(isStaleElementError("")).toBe(false)
  })
})

describe("timerInEvaluateError", () => {
  test("matches the live setTimeout sandbox error on evaluate tools", () => {
    expect(timerInEvaluateError("evaluate", "ReferenceError: Unknown identifier 'setTimeout'")).toBe("setTimeout")
    expect(timerInEvaluateError("evaluate_script", "ReferenceError: Unknown identifier 'setInterval'")).toBe(
      "setInterval",
    )
    expect(timerInEvaluateError("browser_evaluate", "setTimeout is not defined")).toBe("setTimeout")
  })

  test("does not match other tools or other errors", () => {
    expect(timerInEvaluateError("click", "ReferenceError: Unknown identifier 'setTimeout'")).toBeUndefined()
    expect(timerInEvaluateError("evaluate", "ReferenceError: Unknown identifier 'foo'")).toBeUndefined()
    expect(timerInEvaluateError("evaluate", "Timeout 30000ms exceeded")).toBeUndefined()
  })
})

describe("snapshot / wait tool discovery", () => {
  test("finds the snapshot tool each snapshot server offers", () => {
    const chrome = [{ name: "take_snapshot" }, { name: "click" }, { name: "evaluate" }, { name: "wait_for" }]
    expect(snapshotToolName(chrome)).toBe("take_snapshot")
    expect(waitToolName(chrome)).toBe("wait_for")
    expect(snapshotToolName([{ name: "browser_snapshot" }, { name: "browser_click" }])).toBe("browser_snapshot")
    expect(waitToolName([{ name: "browser_snapshot" }, { name: "browser_wait_for" }])).toBe("browser_wait_for")
    expect(snapshotToolName([{ name: "snapshot" }, { name: "click" }])).toBe("snapshot")
    expect(snapshotToolName([{ name: "desktop_snapshot" }])).toBe("desktop_snapshot")
  })

  test("returns undefined when the server offers neither", () => {
    expect(snapshotToolName([{ name: "search" }, { name: "resolve" }])).toBeUndefined()
    expect(waitToolName([{ name: "search" }])).toBeUndefined()
  })

  test("isSnapshotTool only matches snapshot tools", () => {
    expect(isSnapshotTool("take_snapshot")).toBe(true)
    expect(isSnapshotTool("browser_snapshot")).toBe(true)
    expect(isSnapshotTool("click")).toBe(false)
    expect(isSnapshotTool("evaluate")).toBe(false)
  })
})

describe("staleElementMessage", () => {
  test("embeds the fresh snapshot and forbids reusing the old uid", () => {
    const message = staleElementMessage({
      original: "Error: Element with uid 2_66 no longer exists on the page",
      snapshotTool: "take_snapshot",
      snapshotText: "- button 'Submit' [uid 2_71]",
    })
    expect(message).toContain("2_66")
    expect(message).toContain("Do not reuse the old uid/ref")
    expect(message).toContain("2_71")
    expect(message).toContain("Fresh snapshot")
    expect(message).toContain("Retry the same action with the new uid/ref")
  })

  test("without a snapshot it names the snapshot tool to call", () => {
    const message = staleElementMessage({
      original: "Error: Element with uid 1_9 no longer exists on the page",
      snapshotTool: "take_snapshot",
    })
    expect(message).toContain("take_snapshot")
    expect(message).not.toContain("Fresh snapshot")
  })

  test("without any snapshot tool it still tells the model to re-snapshot", () => {
    const message = staleElementMessage({ original: "Element with uid 1_9 no longer exists on the page" })
    expect(message).toContain("Take a fresh snapshot first")
  })

  test("bounds a huge snapshot", () => {
    const message = staleElementMessage({
      original: "Element with uid 2_66 no longer exists on the page",
      snapshotTool: "take_snapshot",
      snapshotText: "x".repeat(MAX_SNAPSHOT_CHARS + 1_000),
    })
    expect(message.length).toBeLessThan(MAX_SNAPSHOT_CHARS + 2_000)
    expect(message).toContain("snapshot truncated")
  })
})

describe("timerMessage", () => {
  test("names the wait tool and forbids timers in evaluate", () => {
    const message = timerMessage({ timer: "setTimeout", waitTool: "wait_for" })
    expect(message).toContain("wait_for")
    expect(message).toContain("setTimeout")
    expect(message).toContain("runs without timers")
  })

  test("without a wait tool it still points at waiting, not timers", () => {
    const message = timerMessage({ timer: "setInterval" })
    expect(message).toContain("server's wait tool")
  })
})
