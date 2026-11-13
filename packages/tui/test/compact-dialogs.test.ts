import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
const source=(file:string)=>readFileSync(new URL(`../src/${file}`,import.meta.url),"utf8")
test("Settings and Models opt into compact shared geometry without changing other panels",()=>{
  for(const file of ["component/dialog-config.tsx","component/dialog-model.tsx"])expect(source(file)).toContain("compact")
  const shared=source("ui/dialog-select.tsx")
  expect(shared).toContain("compact?: boolean")
  expect(shared).toContain("index() > 0 && !compact()")
  expect(shared).toContain("i > 0 && !compact()")
  expect(shared).toContain("compact() ? 1 : 4")
  const settings=source("component/dialog-config.tsx")
  expect(settings).not.toContain('border={["top"]}')
  expect(settings).toContain('t("Default value")')
  expect(settings).toContain('defaultDisplay(currentSetting())')
  expect(settings).not.toContain('default: <span')
})
test("Settings keeps both CategoryRail and DialogSelect, with footer owned by the select",()=>{
 const s=source("component/dialog-config.tsx"),rail=s.indexOf("<CategoryRail"),select=s.indexOf("<DialogSelect",rail)
 expect(rail).toBeGreaterThan(0);expect(select).toBeGreaterThan(rail)
 expect(s.slice(rail,select)).toContain('kind="sensor"')
 expect(s.slice(select)).toContain('title={t("Settings")}')
 expect(s.slice(select)).toContain('footer={')
})

test("compact is the default and filtered selection notifies the description owner",()=>{
 const s=source("ui/dialog-select.tsx")
 expect(s).toContain("props.compact !== false")
 expect(s).toContain("const selectedValue = createMemo(() => selected()?.value, undefined, { equals: isDeepEqual })")
 expect(s).toContain("createEffect(on(selectedValue,")
 expect(s).toContain("props.onMove?.(option)")
 expect(s).toContain("rowGap={compact() ? 0 : undefined}")
})
