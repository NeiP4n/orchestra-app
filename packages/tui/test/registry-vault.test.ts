import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
test("Vault appears in Orchestra registry with operator-only secure input, names and confirmed delete", () => {
  const ui = readFileSync(new URL("../src/component/registry-vault.tsx", import.meta.url), "utf8")
  const registry = readFileSync(new URL("../src/component/devtools-registry.tsx", import.meta.url), "utf8")
  expect(registry).toContain('<Match when={tab() === "vault"}><ProjectRegistryVault /></Match>')
  expect(ui).toContain("vault.writeFromOperator(id, controller.signal,")
  expect(ui).toContain("if (armed() !== id)")
  expect(ui).toContain("vault.deleteFromOperator(id, true)")
  expect(ui).not.toContain("<input")
  expect(ui).not.toContain("<textarea")
  expect(ui).not.toContain(".blob")
  expect(ui).not.toContain("entry.password")
  expect(ui).toContain("без повторного ввода секрета")
  expect(ui).toContain("vault.bindFromOperator!")
})

test("Vault add button has an explicit visible hit area, release handler and hover instead of a press-state trap", () => {
  const ui = readFileSync(new URL("../src/component/registry-vault.tsx", import.meta.url), "utf8")
  expect(ui).toContain('id="registry-vault.add" border borderStyle="rounded"')
  expect(ui).toContain('onMouseUp={(event) => { event.stopPropagation(); if (!busy()) void write() }}')
  expect(ui).toContain('tint(theme.background.base, theme.text.base, 0.12)')
  expect(ui).not.toContain('theme.background.action.primary.focused')
  expect(ui).toContain('<text fg={theme.text.base} wrapMode="none">{busy()')
  expect(ui).toContain('Windows сообщила о показе окна.')
  expect(ui).toContain('SHOWN: ${status.handle}')
  expect(ui).toContain('Ctrl+N добавить · Enter заменить · Ctrl+D дважды удалить.')
})
