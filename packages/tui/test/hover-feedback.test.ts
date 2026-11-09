import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
test("visual-only hover helper does not change mouse-release/selection semantics", () => {
  const text = readFileSync(new URL("../src/ui/hover-feedback.ts", import.meta.url), "utf8")
  expect(text).toContain("hoverBackground(theme, variant)")
  expect(text).toContain("onMouseOver")
  expect(text).toContain("onMouseOut")
  expect(text).not.toContain("stopPropagation()")
  expect(text).not.toContain("onMouseUp:")
  expect(text).not.toContain("onMouseDown:")
  const link = readFileSync(new URL("../src/ui/link.tsx", import.meta.url), "utf8")
  expect(link).toContain("hover.background() ?? props.bg")
  expect(link).toContain("openUrl(props.href)")
})
