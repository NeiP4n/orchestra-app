import { describe, expect, test } from "bun:test"
import { BrowserGuard } from "@orchestra/core/browser/guard"

describe("BrowserGuard", () => {
  test("refuses commands that start a browser or hand a web address to the opener", () => {
    for (const command of [
      "start msedge https://x.com",
      "start https://x.com",
      'cmd /c start "" https://x.com',
      'powershell -c "Start-Process https://x.com"',
      "xdg-open https://x.com",
      "open -a Safari https://x.com",
      "msedge.exe https://x.com",
      '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" https://x.com',
      "firefox https://x.com",
      "echo hi && explorer.exe https://x.com",
    ])
      expect(BrowserGuard.launchesBrowser(command)).toBe(true)
  })
  test("leaves ordinary commands, windowless runs and mentions alone", () => {
    for (const command of [
      "git status",
      "grep chrome README.md",
      "echo start https is a word",
      "chrome --headless --screenshot=a.png https://x.com",
      "google-chrome --version",
      "open ./notes.txt",
      "bun test",
    ])
      expect(BrowserGuard.launchesBrowser(command)).toBe(false)
  })
  test("desktop open refuses web addresses and browsers, not files", () => {
    expect(BrowserGuard.opensBrowser("https://x.com")).toBe(true)
    expect(BrowserGuard.opensBrowser("msedge")).toBe(true)
    expect(BrowserGuard.opensBrowser("C:\\Windows\\notepad.exe")).toBe(false)
  })
})
