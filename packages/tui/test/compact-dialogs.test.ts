import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
const source=(file:string)=>readFileSync(new URL(`../src/${file}`,import.meta.url),"utf8")
test("Settings and Models opt into compact shared geometry without changing other panels",()=>{
  for(const file of ["component/dialog-config.tsx","component/dialog-model.tsx"])expect(source(file)).toContain("compact")
  const shared=source("ui/dialog-select.tsx")
  expect(shared).toContain("compact?: boolean")
  expect(shared).toContain("index() > 0 && !props.compact")
  expect(shared).toContain("i > 0 && !props.compact")
  expect(shared).toContain("props.compact ? 1 : 4")
  const settings=source("component/dialog-config.tsx")
  expect(settings).not.toContain('border={["top"]}')
  expect(settings).toContain('t("Default value")')
  expect(settings).toContain('defaultDisplay(currentSetting())')
  expect(settings).not.toContain('default: <span')
})
