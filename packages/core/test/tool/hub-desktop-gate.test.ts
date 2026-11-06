import { describe, expect, test } from "bun:test"
import { Hub } from "@orchestra/core/hub/index"
import { DesktopIsolation } from "@orchestra/core/desktop-isolation"

// G2-9: the hub is a second agent-reachable shell path, and HubTool.prepare
// runs the same forbiddenDesktopEscape gate as the shell tool. These tests
// prove the shipped screen-touching entries are caught by that gate: every
// mobile.adb-* entry renders a command the gate refuses, while ordinary
// entries render clean. (The wiring itself — HubTool.prepare calling the
// gate before shell.create — is three lines in hub.ts; no end-to-end hub
// plugin harness exists in this repo: the plugin needs Job, Environment and
// other services the PluginTestLayer does not provide.)

const machine: Hub.Machine = {
  platform: "linux",
  locate: (tool) => ({ name: tool, path: `/bin/${tool}` }),
  shell: (backend) => (backend === "bash" ? "/bin/bash" : undefined),
}

const render = (id: string, args: Record<string, string> = {}): string => {
  const entry = Hub.get(id)
  expect(entry).toBeDefined()
  return Hub.prepare(entry!, args, { machine }).command
}

const env = { ORCHESTRA_DESKTOP_CAPTURE: "on" } as NodeJS.ProcessEnv

describe("G2-9 hub gate", () => {
  test("every mobile.adb-* entry renders a command the screen gate refuses", () => {
    const cases: Array<[string, Record<string, string>]> = [
      ["mobile.adb-devices", {}],
      ["mobile.adb-install", { apk: "app.apk" }],
      ["mobile.adb-launch", { package: "com.example.app" }],
      ["mobile.adb-logcat", { lines: "100" }],
      ["mobile.adb-screencap", {}],
      ["mobile.adb-pull", { remote: "/sdcard/x.png", output: "x.png" }],
    ]
    for (const [id, args] of cases) {
      const command = render(id, args)
      expect(command).toContain("adb")
      expect(DesktopIsolation.forbiddenDesktopEscape(command, env)).toContain("Refusing")
    }
  })

  test("ordinary entries render commands the screen gate lets through", () => {
    for (const [id, args] of [
      ["process.list", { limit: "5" }],
      ["search.content", { pattern: "TODO", path: "." }],
      ["git.status", {}],
    ] as const) {
      expect(DesktopIsolation.forbiddenDesktopEscape(render(id, args), env)).toBeUndefined()
    }
  })
})
