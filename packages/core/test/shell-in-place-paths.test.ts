import { expect, test } from "bun:test"
import path from "node:path"
import { ShellInPlacePaths } from "@orchestra/core/shell/in-place-paths"

test("in-place target extraction separates sed scripts from literal paths and ignores non-mutating commands", () => {
  const cwd = path.resolve("project")
  const file = path.resolve("foreign", "held.txt")
  expect(ShellInPlacePaths.targets(`sed -i 's/original/changed/g' '${file}'`, "bash", cwd)).toEqual([file])
  expect(ShellInPlacePaths.targets(`sed -i '/pattern/d' '${file}'`, "bash", cwd)).toEqual([file])
  expect(ShellInPlacePaths.targets(`sed --in-place=.bak -e '/pattern/d' '${file}'`, "bash", cwd)).toEqual([file])
  expect(ShellInPlacePaths.targets(`sed '/pattern/d' '${file}'`, "bash", cwd)).toEqual([])
  expect(ShellInPlacePaths.targets(`cat '${file}'`, "bash", cwd)).toEqual([])
  expect(ShellInPlacePaths.targets(`sed -i 's/a/b/' '$TARGET'`, "bash", cwd)).toEqual([])
})

test("PowerShell path parameters do not confuse content with paths", () => {
  const cwd = path.resolve("project")
  const file = path.resolve("foreign", "held.txt")
  expect(ShellInPlacePaths.targets(`Set-Content -LiteralPath '${file}' -Value '/not/a/path'`, "pwsh", cwd)).toEqual([file])
  expect(ShellInPlacePaths.targets(`Get-Content -LiteralPath '${file}'`, "pwsh", cwd)).toEqual([])
})
