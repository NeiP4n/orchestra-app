import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import { createTestRenderer, ManualClock } from "@opentui/core/testing"
import type { OrchestraEvent } from "@orchestra/client"
import { resolveThemeDocument } from "@orchestra/theme/tui"
import { getOrchestraTheme, getSculkTheme } from "../../src/theme"
import { NeuralActivity } from "../../src/component/neural-activity"
import { neuralPalette, NeuralCanvasRenderable } from "../../src/component/neural"

// SAFETY: decision fixtures supply only the fields NeuralActivity reads, without a model or provider request.
const event = (type: string, sessionID: string) => ({ id: "evt_wait", type, data: { sessionID } }) as unknown as OrchestraEvent

for (const themeName of ["sculk", "orchestra"] as const) {
  for (const mode of ["dark", "light"] as const) {
    test(`approval wait paints from initial options, scopes events and clears (${themeName} ${mode})`, async () => {
      const clock = new ManualClock()
      const app = await createTestRenderer({ width: 90, height: 18, useThread: false, clock })
      app.renderer.pause()
      const theme = resolveThemeDocument(themeName === "sculk" ? getSculkTheme() : getOrchestraTheme(), mode)
      app.renderer.root.backgroundColor = theme.background.base
      const activity = new NeuralActivity()
      const canvas = new NeuralCanvasRenderable(app.renderer, {
        width: 90,
        height: 18,
        kind: "field",
        palette: neuralPalette(theme),
        backdrop: theme.background.base,
        activity,
        functionalEffects: true,
        session: "ses_a",
        names: { ses_a: "Agent A" },
      })
      app.renderer.root.add(canvas)
      try {
        await app.renderOnce()
        activity.take(event("permission.asked", "ses_b"))
        await app.renderOnce()
        expect(app.captureCharFrame()).not.toMatch(/[◐◑]/)
        activity.take(event("permission.asked", "ses_a"))
        await app.renderOnce()
        expect(app.captureCharFrame()).toMatch(/[◐◑]/)
        expect(app.captureCharFrame()).toContain("Agent A")
        const directory = process.env.ORCHESTRA_VISUAL_DIR
        if (directory) {
          await mkdir(directory, { recursive: true })
          await Bun.write(`${directory}/wait-${themeName}-${mode}.json`, JSON.stringify(app.captureSpans()))
        }
        activity.take(event("permission.replied", "ses_a"))
        await app.renderOnce()
        expect(app.captureCharFrame()).not.toMatch(/[◐◑]/)
        activity.take(event("permission.asked", "ses_a"))
        await app.renderOnce()
        expect(app.captureCharFrame()).toMatch(/[◐◑]/)
        canvas.functionalEffects = false
        await app.renderOnce()
        expect(app.captureCharFrame()).not.toMatch(/[◐◑]/)
      } finally {
        canvas.destroy()
        app.renderer.destroy()
      }
    })
  }
}
