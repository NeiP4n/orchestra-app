import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
test("Vault appears in Orchestra registry with operator-only secure input, names and confirmed delete", () => {
  const ui = readFileSync(new URL("../src/component/registry-vault.tsx", import.meta.url), "utf8")
  const registry = readFileSync(new URL("../src/component/devtools-registry.tsx", import.meta.url), "utf8")
  expect(registry).toContain('<Match when={tab() === "vault"}><RegistryVault /></Match>')
  expect(ui).toContain("vault.writeFromOperator(id)")
  expect(ui).toContain("if (armed() !== id)")
  expect(ui).toContain("vault.deleteFromOperator(id, true)")
  expect(ui).not.toContain("<input")
  expect(ui).not.toContain("<textarea")
  expect(ui).not.toContain(".blob")
  expect(ui).not.toContain("entry.password")
  expect(ui).toContain("Подстановка ещё отключена")
})

test("Vault add button has an explicit visible hit area, release handler and hover instead of a press-state trap", () => {
  const ui = readFileSync(new URL("../src/component/registry-vault.tsx", import.meta.url), "utf8")
  expect(ui).toContain('id="registry-vault.add" border borderStyle="rounded"')
  expect(ui).toContain('onMouseUp={(event) => { event.stopPropagation(); if (!busy()) void write() }}')
  expect(ui).toContain('hoverBackground(theme)')
  expect(ui).toContain('Открывается защищённое окно Windows')
  expect(ui).toContain('Ctrl+N добавить · Enter заменить · Ctrl+D дважды удалить.')
})
