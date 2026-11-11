/** @jsxImportSource @opentui/solid */
import { test, expect } from "bun:test"
import { writeFileSync } from "node:fs"
import { testRender } from "@opentui/solid"
import { ConfigProvider } from "../src/config"
import { Keymap } from "../src/context/keymap"
import { ThemeProvider } from "../src/context/theme"
import { DialogProvider } from "../src/ui/dialog"
import { ToastProvider } from "../src/ui/toast"
import { TestTuiContexts } from "./fixture/tui-environment"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"
import { tmpdir, emptyThemeSource } from "./fixture/fixture"
import { ScheduleList } from "../src/component/schedule-list"
import { ScheduleView } from "@orchestra/core/schedule-view"
import { ScheduleRequests } from "@orchestra/core/schedule-requests"
import { BrowserSchedule } from "@orchestra/core/browser/schedule"
import { Trigger } from "@orchestra/core/trigger"

test.each([60, 100])(
  "schedule sidebar stays one line; centered window explains tasks and confirms removal at width %s",
  async (width) => {
    await using root = await tmpdir()
    const previous = process.env.ORCHESTRA_DATA_DIR
    process.env.ORCHESTRA_DATA_DIR = root.path
    const made = Trigger.create(
      { kind: "browser", spec: "fixture_browser", prompt: "Сообщить о новом сообщении от друга" },
      { id: "trg_modal", projectID: "p", now: Date.now(), existing: 0 },
    )
    if (!made.ok) throw Error(made.error)
    ScheduleView.sync(made.trigger, "ses_modal")
    BrowserSchedule.sync({ ...made.trigger, browserSessionID: made.trigger.spec })
    BrowserSchedule.watchStatus(made.trigger.id, true)
    const app = await testRender(
      () => (
        <TestTuiContexts paths={{ state: root.path, home: root.path, worktree: root.path }}>
          <ConfigProvider config={createTuiResolvedConfig({ animations: false, language: "ru" })}>
            <Keymap.Provider>
              <ThemeProvider mode="dark" source={emptyThemeSource}>
                <ToastProvider>
                  <DialogProvider>
                    <ScheduleList sessionID="ses_modal" width={width - 4} />
                  </DialogProvider>
                </ToastProvider>
              </ThemeProvider>
            </Keymap.Provider>
          </ConfigProvider>
        </TestTuiContexts>
      ),
      { width, height: 36, useThread: false, kittyKeyboard: true },
    )
    try {
      app.renderer.start()
      await new Promise((done) => setTimeout(done, 150))
      await app.renderOnce()
      const sidebar = app.captureCharFrame()
      expect(sidebar).toContain("Триггеры: 1/1")
      expect(sidebar).not.toContain("Последний результат")
      await app.mockMouse.click(4, 0)
      await app.renderOnce()
      let frame = app.captureCharFrame()
      expect(frame).toContain("Сообщить о новом сообщении")
      expect(frame).toContain("Лимиты:")
      expect(frame).toContain("Последний результат: ожидание")
      expect(frame).toContain("Пауза")
      expect(frame).toContain("Шаблон")
      const titleRow = frame.split("\n").findIndex((line) => line.includes("Триггеры") && !line.includes("1/1"))
      expect(titleRow).toBeGreaterThan(0)
      app.mockInput.pressKey("p")
      await app.renderOnce()
      expect(ScheduleRequests.read(made.trigger.id, "ses_modal")?.action).toBe("pause")
      expect(ScheduleView.list("ses_modal")[0]?.enabled).toBe(true)
      frame = app.captureCharFrame()
      const actionRow = frame.split("\n").findIndex((line) => line.includes("d Удалить"))
      expect(actionRow).toBeGreaterThan(titleRow)
      await app.mockMouse.click(frame.split("\n")[actionRow]!.indexOf("d Удалить") + 2, actionRow)
      await app.renderOnce()
      expect(ScheduleView.removalRequested(made.trigger.id, "ses_modal")).toBe(false)
      frame = app.captureCharFrame()
      expect(frame).toContain("Точно удалить?")
      expect(ScheduleRequests.read(made.trigger.id, "ses_modal")?.action).toBe("pause")
      if (process.env.ORCHESTRA_CAPTURE_SCHEDULES) {
        writeFileSync(`/downloads/schedules-${width}.txt`, frame)
        writeFileSync(`/downloads/schedules-${width}.spans.json`, JSON.stringify(app.captureSpans()))
      }
    } finally {
      app.renderer.destroy()
      if (previous === undefined) delete process.env.ORCHESTRA_DATA_DIR
      else process.env.ORCHESTRA_DATA_DIR = previous
    }
  },
  30_000,
)
test.each([
  ["interval", 60],
  ["browser", 60],
  ["interval", 100],
  ["browser", 100],
] as const)(
  "reviewed activation of paused %s requires exact review and browser confirmation at width %s",
  async (kind, width) => {
    await using root = await tmpdir()
    const previous = process.env.ORCHESTRA_DATA_DIR
    process.env.ORCHESTRA_DATA_DIR = root.path
    const made = Trigger.create(
      { kind, spec: kind === "browser" ? "fixture_browser" : "60", prompt: "Прочитать статус без публикации" },
      { id: "trg_modal", projectID: "p", now: Date.now(), existing: 0 },
    )
    if (!made.ok) throw Error(made.error)
    ScheduleView.sync({ ...made.trigger, enabled: false, nextAt: null, publishApproved: false }, "ses_modal")
    BrowserSchedule.sync({ ...made.trigger, browserSessionID: made.trigger.spec })
    BrowserSchedule.watchStatus(made.trigger.id, true)
    const app = await testRender(
      () => (
        <TestTuiContexts paths={{ state: root.path, home: root.path, worktree: root.path }}>
          <ConfigProvider config={createTuiResolvedConfig({ animations: false, language: "ru" })}>
            <Keymap.Provider>
              <ThemeProvider mode="dark" source={emptyThemeSource}>
                <ToastProvider>
                  <DialogProvider>
                    <ScheduleList sessionID="ses_modal" width={width - 4} />
                  </DialogProvider>
                </ToastProvider>
              </ThemeProvider>
            </Keymap.Provider>
          </ConfigProvider>
        </TestTuiContexts>
      ),
      { width, height: 36, useThread: false, kittyKeyboard: true },
    )
    try {
      app.renderer.start()
      await new Promise((done) => setTimeout(done, 150))
      await app.renderOnce()
      const sidebar = app.captureCharFrame()
      expect(sidebar).toContain("Триггеры: 0/1")
      await app.mockMouse.click(4, 0)
      await app.renderOnce()
      let frame = app.captureCharFrame()
      expect(frame).toContain("Инструкция: Прочитать статус без публикации")
      expect(frame).toContain("Включить проверенные триггеры")
      app.mockInput.pressKey("a")
      await app.renderOnce()
      expect(ScheduleRequests.read(made.trigger.id, "ses_modal")).toBeUndefined()
      app.mockInput.pressKey("c")
      await app.renderOnce()
      app.mockInput.pressKey("a")
      await app.renderOnce()
      if (kind === "browser") {
        expect(ScheduleRequests.read(made.trigger.id, "ses_modal")).toBeUndefined()
        app.mockInput.pressKey("b")
        await app.renderOnce()
        app.mockInput.pressKey("a")
        await app.renderOnce()
      }
      const command = ScheduleRequests.read(made.trigger.id, "ses_modal")
      expect(command?.action).toBe("resume")
      expect(command?.reviewedDigest).toMatch(/^[a-f0-9]{64}$/)
      expect(ScheduleView.list("ses_modal")[0]?.enabled).toBe(false)
      frame = app.captureCharFrame()
      expect(frame).not.toContain("Включено: 1")
      if (process.env.ORCHESTRA_CAPTURE_SCHEDULES) {
        writeFileSync(`${root.path}/reviewed-trigger-${kind}-${width}.txt`, frame)
        writeFileSync(`${root.path}/reviewed-trigger-${kind}-${width}.spans.json`, JSON.stringify(app.captureSpans()))
      }
    } finally {
      app.renderer.destroy()
      if (previous === undefined) delete process.env.ORCHESTRA_DATA_DIR
      else process.env.ORCHESTRA_DATA_DIR = previous
    }
  },
  30_000,
)
