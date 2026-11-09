import { expect, test } from "bun:test"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { SCRIPT } from "@orchestra/core/credential-vault/windows"


test("native captions survive production bundling without literal Unicode escapes", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vault-bundle-"))
  try {
    const build = await Bun.build({
      entrypoints: [path.resolve(import.meta.dir, "../src/credential-vault/windows.ts")],
      target: "bun",
      format: "esm",
    })
    expect(build.success).toBe(true)
    const file = path.join(directory, "collector.mjs")
    await writeFile(file, await build.outputs[0]!.text())
    const bundled = await import(file)
    for (const script of [SCRIPT, bundled.SCRIPT]) {
      expect(script).not.toMatch(/\\u[0-9a-f]{4}/i)
      expect(script).toContain("$labels = @('Название', 'Сайт', 'Логин', 'Пароль')")
      expect(script).toContain("$ok.Text = 'Сохранить'")
      expect(script).toContain("$cancel.Text = 'Отмена'")
      expect(script).toContain("if ($i -ge 2) { $box.UseSystemPasswordChar = $true }")
    }
  } finally { await rm(directory, { recursive: true, force: true }) }
})
