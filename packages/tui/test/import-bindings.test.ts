import { expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

// Source-contract tests read UI modules without loading them. Transform every module too,
// so duplicate imports and other startup syntax/scope failures cannot hide behind noCheck.
function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((item) => {
    const path = join(dir, item.name)
    return item.isDirectory() ? files(path) : /\.tsx?$/.test(item.name) ? [path] : []
  })
}
test("startup guard rejects duplicate named default and namespace imports", () => {
  const parser = new Bun.Transpiler({ loader: "tsx" })
  for (const source of [
    'import { x } from "a"\nimport { y as x } from "b"',
    'import X from "a"\nimport X from "b"',
    'import * as X from "a"\nimport * as X from "b"',
  ]) expect(() => parser.transformSync(source)).toThrow()
  expect(() => parser.transformSync('import { x as a, y as b } from "a"\nimport { x } from "b"')).not.toThrow()
})
test("all TUI source modules parse and bind imports without startup errors", () => {
  const parsers = { ts: new Bun.Transpiler({ loader: "ts" }), tsx: new Bun.Transpiler({ loader: "tsx" }) }
  const failures: string[] = []
  for (const path of files(fileURLToPath(new URL("../src/", import.meta.url)))) {
    try { parsers[path.endsWith(".tsx") ? "tsx" : "ts"].transformSync(readFileSync(path, "utf8")) }
    catch (error) { failures.push(`${path}: ${String(error)}`) }
  }
  expect(failures).toEqual([])
})
