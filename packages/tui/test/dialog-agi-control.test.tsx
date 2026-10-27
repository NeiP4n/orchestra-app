import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { RGBA } from "@opentui/core"
import type { Context } from "@orchestra/plugin/tui/context"
import {
  DialogAgiControl,
  AgiStatusIndicator,
  swarmState,
  setSwarmState,
} from "../src/component/dialog-agi-control"
import { renderLocal } from "./fixture/local"

describe("DialogAgiControl & AGI Next-Gen UI (AGI-012 & AGI-013)", () => {
  test("1. DialogAgiControl and AgiStatusIndicator are properly exported", () => {
    expect(typeof DialogAgiControl).toBe("function")
    expect(typeof DialogAgiControl.show).toBe("function")
    expect(typeof AgiStatusIndicator).toBe("function")
    expect(typeof swarmState).toBe("function")
    expect(typeof setSwarmState).toBe("function")
  })

  test("2. Command Palette includes 'agi-control' command", async () => {
    const content = await Bun.file("src/component/command-palette.tsx").text()
    expect(content).toContain('id: "agi-control"')
    expect(content).toContain("DialogAgiControl")
    expect(content).toContain("Управление роем агентов (Swarm Control)")
    expect(content).toContain("dialog.show")
  })

  test("3. DialogAgiControl conforms to native Orchestra design requirements", async () => {
    const content = await Bun.file("src/component/dialog-agi-control.tsx").text()

    // 1. Native components and layout tokens
    expect(content).toContain("DialogSelect")
    expect(content).toContain("theme.background.raised.base")
    expect(content).toContain("theme.text.feedback.success.base")
    expect(content).toContain("theme.text.feedback.error.base")
    expect(content).toContain("•")

    // 2. Strict removal of emoji clutter and pseudo-buttons
    expect(content).not.toMatch(/[\u{1F300}-\u{1F9FF}]/u)
    expect(content).not.toContain("[ - ]")
    expect(content).not.toContain("[ + ]")
    expect(content).not.toContain("AgiButton")

    // 3. 4 Native action items
    expect(content).toContain("Автономный рой (Swarm)")
    expect(content).toContain("toggleSwarm")
    expect(content).toContain('"active"')
    expect(content).toContain('"halted"')

    expect(content).toContain("Когнитивный режим")
    expect(content).toContain("Auto")
    expect(content).toContain("System 1")
    expect(content).toContain("System 2")

    expect(content).toContain("Сброс памяти роя")
    expect(content).toContain("handleResetMemory")
    expect(content).toContain("эпизодический граф")

    expect(content).toContain("Экстренный стоп (Kill-Switch)")
    expect(content).toContain("handleKillSwitch")

    // 4. Status card & telemetry
    expect(content).toContain("Активен")
    expect(content).toContain("Остановлен")
    expect(content).toContain("Узлы")
    expect(content).toContain("Очередь")
    expect(content).toContain("Безопасность")

    // 5. Keyboard accessibility and Esc handling
    expect(content).toContain("dialog.clear()")
    expect(content).toContain("onCancel")

    // 6. Adaptive sizing via useTerminalDimensions
    expect(content).toContain("useTerminalDimensions")
    expect(content).toContain('dimensions().width < 80 ? "medium" : "large"')
  })

  test("4. Footers integrate AgiStatusIndicator for continuous discoverability", async () => {
    const promptFooter = await Bun.file("src/feature-plugins/prompt/footer.tsx").text()
    expect(promptFooter).toContain("AgiStatusIndicator")
    expect(promptFooter).toContain("<AgiStatusIndicator")

    const homeFooter = await Bun.file("src/feature-plugins/home/footer.tsx").text()
    expect(homeFooter).toContain("AgiStatusIndicator")
    expect(homeFooter).toContain("<AgiStatusIndicator")
  })

  test("5. AgiStatusIndicator renders adaptively and reflects swarm state", async () => {
    const color = RGBA.fromInts(0, 255, 0)
    const errColor = RGBA.fromInts(255, 0, 0)
    let opened = false

    const mockContext = {
      theme: {
        text: {
          base: RGBA.fromInts(200, 200, 200),
          feedback: {
            success: { base: color },
            error: { base: errColor },
          },
        },
      },
      ui: {
        dialog: {
          show: () => {
            opened = true
          },
        },
      },
    } as unknown as Context

    // Wide screen (>= 64 cols): full "• Swarm: active"
    setSwarmState("active")
    const appWide = await testRender(() => <AgiStatusIndicator context={mockContext} />, {
      width: 80,
      height: 1,
    })

    try {
      await appWide.renderOnce()
      expect(appWide.captureCharFrame()).toContain("• Swarm: active")

      // Halted state
      setSwarmState("halted")
      await appWide.renderOnce()
      expect(appWide.captureCharFrame()).toContain("• Swarm: halted")

      // Click to open
      await appWide.mockMouse.click(2, 0)
      expect(opened).toBe(true)
    } finally {
      appWide.renderer.destroy()
    }

    // Narrow screen (< 64 cols): compact "• Swarm"
    const appNarrow = await testRender(() => <AgiStatusIndicator context={mockContext} />, {
      width: 50,
      height: 1,
    })

    try {
      await appNarrow.renderOnce()
      const frame = appNarrow.captureCharFrame()
      expect(frame).toContain("• Swarm")
      expect(frame).not.toContain("• Swarm: halted")
    } finally {
      appNarrow.renderer.destroy()
    }

    // Reset back to active for clean state
    setSwarmState("active")
  })

  test("6. DialogAgiControl renders correctly inside TUI dialog harness", async () => {
    await using setup = await renderLocal()
    setup.dialog.replace(() => <DialogAgiControl />)
    await setup.waitForFrame((frame) =>
      frame.includes("Swarm Control") &&
      frame.includes("Автономный рой (Swarm)") &&
      frame.includes("Когнитивный режим") &&
      frame.includes("Узлы")
    )
  })
})
