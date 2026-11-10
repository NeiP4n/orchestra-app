import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import ts from "typescript"
import { translate } from "../src/util/i18n"

const files = ["project-templates-simple.tsx", "registry-vault.tsx", "devtools-registry.tsx"]
function inspect(text: string, filename: string) {
  const source = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const problems: string[] = []
  const plain = (value: string) => /[A-Za-zА-Яа-яЁё]/.test(value)
  const untranslated = (key: string) => plain(key) && key !== "esc" && translate("ru", key) === key
  const visit = (node: ts.Node) => {
    if (ts.isJsxText(node) && plain(node.text)) problems.push("Raw JSX text: " + node.text.trim())
    if (ts.isJsxAttribute(node) && ["label", "title", "placeholder"].includes(node.name.getText(source)) && node.initializer && ts.isStringLiteral(node.initializer) && plain(node.initializer.text)) problems.push("Raw JSX label: " + node.initializer.text)
    if (ts.isPropertyAssignment(node) && node.name.getText(source) === "title" && ts.isStringLiteral(node.initializer)) problems.push("Raw command title: " + node.initializer.text)
    if (ts.isCallExpression(node) && ["t", "tr"].includes(node.expression.getText(source)) && node.arguments[0]) {
      const check = (value: ts.Node) => {
        if (ts.isStringLiteral(value) && untranslated(value.text)) problems.push("Missing Russian key: " + value.text)
        if (ts.isConditionalExpression(value)) { check(value.whenTrue); check(value.whenFalse) }
      }
      check(node.arguments[0])
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return problems
}
for (const file of files) test(`Registry localization guard: ${file}`, async () => {
  const text = await readFile(new URL(`../src/component/${file}`, import.meta.url), "utf8")
  expect(inspect(text, file)).toEqual([])
  expect(text).not.toMatch(/[А-Яа-яЁё]/)
})
test("guard rejects raw labels, command titles and keys without translation", () => {
  expect(inspect('const x = <text>Untranslated label</text>', "test.tsx")).toHaveLength(1)
  expect(inspect('const x = <input placeholder="Untranslated label" />', "test.tsx")).toHaveLength(1)
  expect(inspect('const x = { title: "Untranslated label" }', "test.tsx")).toHaveLength(1)
  expect(inspect('tr("A key deliberately missing from dictionaries")', "test.tsx")).toHaveLength(1)
})
