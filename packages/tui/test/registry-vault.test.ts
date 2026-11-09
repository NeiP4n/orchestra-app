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
