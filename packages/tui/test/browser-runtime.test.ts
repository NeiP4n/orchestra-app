import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"

// The Browser view's wiring is checked on the source: Chrome never starts on its own, every session
// uses its own profile directory, and the chat stays beside the page in a wide window.
const read = (file: string) => fs.readFileSync(path.join(import.meta.dir, "..", "src", file), "utf8")

describe("browser view", () => {
  test("Chrome starts only on request, on a per-session profile, and closes with the TUI", () => {
    const core = fs.readFileSync(path.join(import.meta.dir, "..", "..", "core", "src", "browser", "runtime.ts"), "utf8")
    expect(core).toContain("Chrome.profileDir(Global.Path.data, sessionID)")
    expect(core).toContain('process.on("exit", closeAll)')
    expect(read("util/browser-runtime.ts")).toContain("@orchestra/core/browser/runtime")
    expect(read("component/browser-pane.tsx")).toContain("Open Chrome")
  })

  test("the page is streamed into the pane with the terminal's own image protocol", () => {
    const pane = read("component/browser-pane.tsx")
    expect(pane).toContain("ImageRenderable")
    expect(pane).toContain("BrowserRuntime.watch(")
    expect(pane).toContain("BrowserRuntime.unwatch(")
  })

  test("the pane draws its own tab strip and address row above the page picture; the real Chrome window is only the explicit button", () => {
    const pane = read("component/browser-pane.tsx")
    expect(pane).not.toContain("<input")
    for (const used of ["BrowserRuntime.tabs(", "BrowserRuntime.newTab(", "BrowserRuntime.selectTab(", "BrowserRuntime.history("])
      expect(pane).toContain(used)
    expect(pane.indexOf("tabList()")).toBeLessThan(pane.indexOf("<browserImage"))
    expect(pane).toContain("BrowserRuntime.relaunch(")
  })

  test("the operator can take control and always give it back", () => {
    const pane = read("component/browser-pane.tsx")
    expect(pane).toContain("BrowserRuntime.mouse(")
    expect(pane).toContain("BrowserRuntime.key(")
    expect(pane).toContain('key.ctrl && key.name === "g"')
  })

  test("the chat is shown beside the page only in a wide window", () => {
    const frame = read("component/session-frame.tsx")
    expect(frame).toContain('centerView() === "browser" && dimensions().width >= 110')
    expect(frame).toContain("availableWidth() >= CHAT_BESIDE_WIDTH + 50")
    // The page comes first in the row and the chat after it (not relying on row-reverse): page in the center, chat on the right.
    expect(frame.indexOf('id="center-view"')).toBeGreaterThan(0)
    expect(frame.indexOf('id="center-view"')).toBeLessThan(frame.indexOf('id="session-pane"'))
    expect(frame).not.toContain("row-reverse")
  })

  test("the chat column can be hidden and the choice is saved in the layout", () => {
    const frame = read("component/session-frame.tsx")
    expect(frame).toContain("draft.browserChatHidden = hidden")
    expect(frame).toContain("&& !browserChatHidden()")
    expect(read("component/browser-pane.tsx")).toContain('props.chatHidden ? "Чат +" : "Чат −"')
    expect(read("component/browser-pane.tsx")).toContain('onClick={props.onToggleChat}')
  })
})

describe("the browser pane default", () => {
  test("on Windows every session's Chrome ends up as the captured real window, between the agent's turns; our own strip is emergency-only", () => {
    const pane = read("component/browser-pane.tsx")
    expect(pane).toContain('process.platform === "win32" && process.env.ORCHESTRA_BROWSER_CAPTURE === "1"')
    // One try per session in this process, one switch at a time, only after the windowless picture is on screen,
    // never while the session's BrowserAgent chat is working; no picture within the time limit goes back to headless.
    expect(pane).toContain("captureGaveUp")
    expect(pane).toContain("autoSwitching")
    expect(pane).toContain("FIRST_FRAME_MS")
    expect(pane).toContain("switching.has(props.sessionID)")
    expect(pane).toContain("props.busy?.()")
    expect(pane).toContain('switchMode("capture")')
    expect(read("component/session-frame.tsx")).toContain('data.session.status(item.chat) === "running"')
    // The pane's own tab strip is on by default (ORCHESTRA_BROWSER_STRIP=0 hides it) and never drawn over the captured window.
    expect(pane).toContain('process.env.ORCHESTRA_BROWSER_STRIP !== "0"')
    expect(pane).toContain('STRIP && !windowed() && mode() !== "capture"')
  })

  test("the capture helper proves the window invisible and blank pictures fall back to the windowless Chrome", () => {
    const script = read("../../core/src/browser/window-capture.ts")
    for (const part of ["SetLayeredWindowAttributes", "GetLayeredWindowAttributes", "could not be made invisible", "prints blank", "SetForegroundWindow", "onProblem"])
      expect(script).toContain(part)
    expect(read("../../core/src/browser/runtime.ts")).toContain('relaunch(sessionID, "headless", size)')
  })
})

test("a working BrowserAgent lights up in the session list and in the pane header, from the chat status", async () => {
  const { readFileSync } = await import("node:fs")
  const tree = readFileSync(new URL("../src/component/project-tree.tsx", import.meta.url), "utf8")
  const pane = readFileSync(new URL("../src/component/browser-pane.tsx", import.meta.url), "utf8")
  // BrowserAgent busy feedback is separate from the verified Chrome running dot.
  const row = tree.slice(tree.indexOf("const browserRows"), tree.indexOf("browser-rename:"))
  expect(row).toContain('data.session.status(item.chat) === "running"')
  expect(row.indexOf("<NeuronDot")).toBeGreaterThan(row.indexOf('=== "running"'))
  expect(row).toContain('browserConnected(item.id) ? "● " : "○ "')
  expect(row).toContain('browserConnected(item.id) === undefined ? "? "')
  // The header: shown only while props.busy() holds, which the frame feeds from the same chat status.
  expect(pane).toContain("<Show when={props.busy?.()}>")
  expect(pane).toContain("<NeuronDot")
})

test("the pane header says whether Chrome's own window is shown and why not", async () => {
  const { readFileSync } = await import("node:fs")
  const pane = readFileSync(new URL("../src/component/browser-pane.tsx", import.meta.url), "utf8")
  const line = pane.slice(pane.indexOf("const captureLine"), pane.indexOf("const switchMode"))
  // every reason the user can run into has its own wording
  for (const part of ["captureAttemptOf", "captureRetrying", "capture: retrying", "attempt: ${attempt}", "capture: on", "safe default", "because:", "capture: starting", "first picture", "turn ends", "captureProblemOf"])
    expect(line).toContain(part)
  // the reasons are recorded where capture is given up
  for (const reason of ["you pressed Fast view", "no picture", "did not start"]) expect(pane).toContain(reason)
  expect(pane).toContain("<Show when={DEBUG && captureLine()}>")
  const core = readFileSync(new URL("../../core/src/browser/runtime.ts", import.meta.url), "utf8")
  expect(core).toContain("captureProblems.set(sessionID, text)")
})


test("technical check and capture status stay out of the ordinary browser toolbar", () => {
  const pane = read("component/browser-pane.tsx")
  expect(pane).toContain("DEBUG && scheduledChecks().length > 0")
  expect(pane).toContain("!DEBUG && scheduledChecks().some((check) => check.phase === \"error\")")
  expect(pane).toContain("Подробности в «Расписаниях»")
  expect(pane).not.toContain("Read-only page checks: off")
  expect(pane).toContain('flexWrap="wrap"')
})

test("opening browser pane stays text-only until explicit Screen request, without an image stream by default", () => {
  const pane = read("component/browser-pane.tsx")
  expect(pane).toContain('createSignal<"screen" | "text">("text")')
  expect(pane).toContain('view() !== "screen"')
  expect(pane).toContain('if (!autoCapture || state() !== "ready" || view() !== "screen") return')
  expect(pane).toContain('label="Прочитать"')
  expect(pane).toContain('setPage(await BrowserRuntime.read(props.sessionID))')
})

test("browser toolbar names screen state in Russian, keeps resource line compact and last page read visible", () => {
  const pane = read("component/browser-pane.tsx")
  expect(pane).toContain('"Экран: вкл" : "Экран: выкл"')
  expect(pane).toContain('Chrome:')
  expect(pane).toContain('RAM свободно')
  expect(pane).toContain('Текст страницы · прочитано')
  expect(pane).toContain('<HoverAction paddingLeft={1} paddingRight={1}')
  expect(pane).toContain('columnGap={1} rowGap={0}')
  expect(pane).toContain('wrapMode="none" truncate>Фон · Прочитать: текст · Экран: изображение')
  expect(pane).not.toContain('flexWrap="wrap" flexShrink={0} gap={1}')
})
