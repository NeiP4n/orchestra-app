import { describe, expect, test } from "bun:test"
import { auditUiCode, auditUiDiff, formatAuditReport, type UiViolation } from "@orchestra/core/ui-auditor"

const rules = (violations: readonly UiViolation[]) =>
  violations.map((violation) => `${violation.line}:${violation.rule}`)

describe("auditUiCode: clean UI", () => {
  test("theme tokens, plain labels and labelled buttons produce nothing", () => {
    const code = [
      "const styles = { color: theme.text.base, background: theme.background.panel }",
      'export const Save = () => <button aria-label="Save"><Icon name="save" /></button>',
      "export const Cancel = () => <button>Cancel</button>",
      "export const Count = ({ label }) => <button>{label}</button>",
      "export const Note = () => <p>All changes saved</p>",
    ].join("\n")

    expect(auditUiCode(code, "src/panel.tsx")).toEqual([])
    expect(formatAuditReport([])).toBe("")
  })

  test("a single emoji, a joined family emoji and a class name are not spam", () => {
    const code = ['const done = "готово ✅"', 'const family = "👨‍👩‍👧"', 'const className = "text-sm text-base"'].join("\n")

    expect(auditUiCode(code)).toEqual([])
  })
})

describe("auditUiCode: raw colours", () => {
  test("hex, rgba and a Tailwind arbitrary colour are errors on their own lines", () => {
    const code = [
      'const a = <div style={{ color: "#fff" }} />',
      'const b = <div style={{ background: "rgba(0,0,0,0.5)" }} />',
      'const c = <div className="p-2 [#1a1a1a]" />',
    ].join("\n")

    const violations = auditUiCode(code, "src/panel.tsx")

    expect(rules(violations)).toEqual(["1:no-raw-colors", "2:no-raw-colors", "3:no-raw-colors"])
    expect(violations.every((violation) => violation.severity === "error")).toBe(true)
    expect(violations.map((violation) => violation.offending)).toEqual(["#fff", "rgba(", "#1a1a1a"])
  })

  test("a style object spanning lines still catches the value", () => {
    const code = [
      "export const Stripes = () => (",
      "  <div",
      "    style={{",
      "      background:",
      '        "radial-gradient(ellipse 59% 40% at center, black 0%, rgba(0,0,0,0.72) 58%, transparent 100%)",',
      "    }}",
      "  />",
      ")",
    ].join("\n")

    expect(rules(auditUiCode(code, "src/stripes.tsx"))).toEqual(["5:no-raw-colors"])
  })

  test("a colour in a comment is not a violation", () => {
    const code = ["// the old panel used #fff here", "* border: 1px solid #ccc", "{/* was rgba(0,0,0,.4) */}"].join(
      "\n",
    )

    expect(auditUiCode(code)).toEqual([])
  })

  test("a hex literal that is not styling (a token or an anchor) is not flagged", () => {
    const code = ['const brand = "#fff"', 'const href = "docs#abc123"'].join("\n")

    expect(auditUiCode(code)).toEqual([])
  })

  test("a CSS file flags a bare colour without a style prop", () => {
    expect(rules(auditUiCode(":root { --panel: #1a1a1a; }", "src/theme.css"))).toEqual(["1:no-raw-colors"])
  })

  test("a named CSS colour is a semantic-token warning", () => {
    const violations = auditUiCode('const s = { color: "red" }', "src/panel.tsx")

    expect(rules(violations)).toEqual(["1:semantic-tokens"])
    expect(violations[0]?.severity).toBe("warning")
    expect(violations[0]?.offending).toBe('color: "red')
  })
})

describe("auditUiCode: emoji and shouting", () => {
  test("two or more emoji in a row are reported once with the run", () => {
    const violations = auditUiCode(['const label = "🔥🔥"', 'const warn = "⚠️⚠️"'].join("\n"))

    expect(rules(violations)).toEqual(["1:no-emoji-spam", "2:no-emoji-spam"])
    expect(violations[0]?.offending).toBe("🔥🔥")
    expect(violations[0]?.severity).toBe("warning")
  })

  test("shouting markers are reported", () => {
    const violations = auditUiCode(['const t = "[!!!] Danger"', 'const s = "Saved!!!"'].join("\n"))

    expect(rules(violations)).toEqual(["1:no-emoji-spam", "2:no-emoji-spam"])
    expect(violations.map((violation) => violation.offending)).toEqual(["[!!!]", "!!!"])
  })
})

describe("auditUiCode: accessible labels", () => {
  test("an icon-only button without a label is an error on the opening line", () => {
    const code = ["export const Close = () => (", "  <button>", '    <Icon name="close" />', "  </button>", ")"].join(
      "\n",
    )

    const violations = auditUiCode(code, "src/panel.tsx")
    expect(rules(violations)).toEqual(["2:accessible-labels"])
    expect(violations[0]?.severity).toBe("error")
  })

  test("a self-closing button with no label is an error", () => {
    expect(rules(auditUiCode("<button onClick={close} />"))).toEqual(["1:accessible-labels"])
  })

  test("a label, a title or visible text satisfies the rule", () => {
    const code = [
      '<button aria-label="Close"><Icon name="close" /></button>',
      '<button title="Close"><Icon name="close" /></button>',
      "<button>Close</button>",
      '<Button aria-label="Save" />',
      '<Button label="Close" run={close} />',
    ].join("\n")

    expect(auditUiCode(code, "src/panel.tsx")).toEqual([])
  })

  test("a component child that may render its own text is not called empty", () => {
    const code = [
      '<button type="button">',
      "  <HomeSessionTitle title={title()} />",
      "  <Show when={open()}><HomeSessionProjectName name={name()} /></Show>",
      "</button>",
    ].join("\n")

    expect(auditUiCode(code, "src/panel.tsx")).toEqual([])
  })

  test("a comment alone inside a button is not a label", () => {
    expect(rules(auditUiCode("<button>{/* icon goes here */}</button>"))).toEqual(["1:accessible-labels"])
  })

  test("a text-only file is not searched for buttons", () => {
    expect(auditUiCode("<button />", "src/panel.css")).toEqual([])
  })
})

describe("auditUiDiff", () => {
  const patch = [
    "diff --git a/src/panel.tsx b/src/panel.tsx",
    "--- a/src/panel.tsx",
    "+++ b/src/panel.tsx",
    "@@ -10,3 +10,4 @@",
    " const kept = theme.text.base",
    '-const old = <div style={{ color: "#fff" }} />',
    '+const fresh = <div style={{ color: "#123456" }} />',
    " const tail = 1",
  ].join("\n")

  test("reports an added line with the line number it has in the new file", () => {
    const violations = auditUiDiff(patch)

    expect(rules(violations)).toEqual(["11:no-raw-colors"])
    expect(violations[0]?.offending).toBe("#123456")
  })

  test("a removed line and the patch headers are not audited", () => {
    const removedOnly = [
      "--- a/src/panel.tsx",
      "+++ b/src/panel.tsx",
      "@@ -1,1 +1,1 @@",
      '-const old = <div style={{ color: "#fff" }} />',
      " const kept = 1",
    ].join("\n")

    expect(auditUiDiff(removedOnly)).toEqual([])
  })

  test("two files keep their own names and line numbers", () => {
    const multi = [
      "--- a/src/a.tsx",
      "+++ b/src/a.tsx",
      "@@ -1,1 +1,2 @@",
      " const a = 1",
      '+const bad = <button style={{ color: "#fff" }} />',
      "--- a/src/b.css",
      "+++ b/src/b.css",
      "@@ -5,1 +5,2 @@",
      " .x { padding: 0 }",
      "+.y { color: #abcdef; }",
    ].join("\n")

    expect(rules(auditUiDiff(multi))).toEqual(["2:no-raw-colors", "1:accessible-labels", "6:no-raw-colors"])
  })

  test("an empty patch has nothing to say", () => {
    expect(auditUiDiff("")).toEqual([])
    expect(formatAuditReport(auditUiDiff(""))).toBe("")
  })
})

describe("formatAuditReport", () => {
  test("lists each violation with its line, severity, rule and offending text", () => {
    const violations = auditUiCode(['const a = <div style={{ color: "#fff" }} />', 'const b = "🔥🔥"'].join("\n"))
    const report = formatAuditReport(violations)

    expect(report.startsWith("2 UI violation(s):")).toBe(true)
    expect(report).toContain("line 1: error no-raw-colors — hardcoded colour bypasses the theme")
    expect(report).toContain('("#fff")')
    expect(report).toContain("line 2: warning no-emoji-spam")
  })

  test("a long report is clipped", () => {
    const violations: UiViolation[] = Array.from({ length: 80 }, (_, index) => ({
      rule: "no-raw-colors",
      severity: "error",
      line: index + 1,
      message: "hardcoded colour bypasses the theme; use a semantic token instead",
      offending: "#abcdef",
    }))

    expect(formatAuditReport(violations).length).toBeLessThanOrEqual(2000)
  })
})
