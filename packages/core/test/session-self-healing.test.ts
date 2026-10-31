import { describe, expect, test } from "bun:test"
import {
  createHealingContext,
  parseDiagnostics,
  summarize,
  type Diagnostic,
} from "@orchestra/core/session/self-healing"

describe("parseDiagnostics: TypeScript", () => {
  test("reads the tsgo parenthesis form with a Windows path", () => {
    const diagnostics = parseDiagnostics(
      "C:\\repo\\packages\\core\\src\\a.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.\n",
    )

    expect(diagnostics).toEqual([
      {
        kind: "typescript",
        message: "Type 'string' is not assignable to type 'number'.",
        file: "C:/repo/packages/core/src/a.ts",
        line: 12,
        column: 5,
        code: "TS2322",
      },
    ])
  })

  test("reads the dash form and keeps several errors in order", () => {
    const diagnostics = parseDiagnostics(
      [
        "src/a.ts:12:5 - error TS2322: Type 'string' is not assignable to type 'number'.",
        "src/b.ts:3:1 - error TS2304: Cannot find name 'foo'.",
        "",
      ].join("\n"),
    )

    expect(diagnostics.map((diagnostic) => [diagnostic.file, diagnostic.line, diagnostic.code])).toEqual([
      ["src/a.ts", 12, "TS2322"],
      ["src/b.ts", 3, "TS2304"],
    ])
  })

  test("a TS1xxx code is a syntax error, TS2xxx a type error", () => {
    const diagnostics = parseDiagnostics(
      ["src/a.ts(1,10): error TS1005: ';' expected.", "src/a.ts(2,1): error TS2741: Property 'id' is missing."].join(
        "\n",
      ),
    )

    expect(diagnostics.map((diagnostic) => diagnostic.kind)).toEqual(["syntax", "typescript"])
  })

  test("an indented explanation stays part of the message", () => {
    const diagnostics = parseDiagnostics(
      [
        "src/a.ts(1,2): error TS2322: Type 'string' is not assignable to type 'number'.",
        "  The expected type comes from property 'count' which is declared here on type 'Options'.",
      ].join("\n"),
    )

    expect(diagnostics[0]?.message).toBe(
      "Type 'string' is not assignable to type 'number'. The expected type comes from property 'count' which is declared here on type 'Options'.",
    )
  })

  test("a real bun typecheck summary line is not mistaken for an error", () => {
    const diagnostics = parseDiagnostics(
      [
        "$ tsgo -b tsconfig.json",
        "src/a.ts(1,1): error TS1005: ';' expected.",
        'error: script "typecheck" exited with code 1',
        "",
      ].join("\n"),
    )

    expect(diagnostics).toHaveLength(2)
    expect(diagnostics[1]).toMatchObject({ kind: "unknown", message: 'script "typecheck" exited with code 1' })
  })
})

describe("parseDiagnostics: failing tests", () => {
  test("reads a bun failure with its assertion and stack location", () => {
    const output = [
      "test/checkpoint.test.ts:",
      "12 |   expect(total).toBe(2)",
      "   |                 ^",
      "error: expect(received).toBe(expected)",
      "",
      "Expected: 2",
      "Received: 1",
      "",
      "      at <anonymous> (C:/repo/packages/core/test/checkpoint.test.ts:12:34)",
      "",
      "(fail) checkpoint restore > writes the file back [0.52ms]",
      "",
      " 1 pass",
      " 1 fail",
    ].join("\n")

    const diagnostics = parseDiagnostics(output)
    const failures = diagnostics.filter((diagnostic) => diagnostic.kind === "test")

    expect(failures).toHaveLength(1)
    expect(failures[0]?.message).toBe("checkpoint restore > writes the file back")
    expect(failures[0]?.expected).toBe("2")
    expect(failures[0]?.actual).toBe("1")
    expect(failures[0]?.file).toBe("C:/repo/packages/core/test/checkpoint.test.ts")
    expect(failures[0]?.line).toBe(12)
    expect(failures[0]?.column).toBe(34)
  })

  test("puts the test name and the stack of a later (fail) line together", () => {
    const output = [
      "(fail) desktop_action rendering > a long answer stays inside the budget [0.73ms]",
      "error: expect(received).toContain(expected)",
      'Expected to contain: "clicked"',
      'Received: "invoked \\"Семь\\""',
      "      at <anonymous> (C:/repo/packages/core/test/desktop-action.test.ts:125:52)",
    ].join("\n")

    const [failure] = parseDiagnostics(output)
    expect(failure?.kind).toBe("test")
    expect(failure?.message).toBe("desktop_action rendering > a long answer stays inside the budget")
    expect(failure?.expected).toBe('contain: "clicked"')
    expect(failure?.actual).toBe('"invoked \\"Семь\\""')
    expect(failure?.file).toBe("C:/repo/packages/core/test/desktop-action.test.ts")
    expect(failure?.line).toBe(125)
  })

  test("reads a vitest failure with its file and assertion", () => {
    const output = [
      "FAIL src/sum.test.ts > sum > adds numbers",
      "AssertionError: expected 1 to be 2",
      " ❯ src/sum.test.ts:12:34",
      "    10|   it('adds numbers', () => {",
    ].join("\n")

    const [failure] = parseDiagnostics(output)
    expect(failure).toMatchObject({
      kind: "test",
      message: "sum > adds numbers",
      file: "src/sum.test.ts",
      expected: "2",
      actual: "1",
    })
  })

  test("a timeout failure keeps the test name", () => {
    const [failure] = parseDiagnostics("(fail) project tree > renders the council [5000.00ms]")
    expect(failure?.kind).toBe("test")
    expect(failure?.message).toBe("project tree > renders the council")
  })
})

describe("parseDiagnostics: syntax and runtime", () => {
  test("a bun parser error with a location is a syntax error", () => {
    const [diagnostic] = parseDiagnostics(
      ['error: Expected ";" but found "}"', "    at C:/repo/src/a.ts:7:3", ""].join("\n"),
    )

    expect(diagnostic).toMatchObject({
      kind: "syntax",
      message: 'Expected ";" but found "}"',
      file: "C:/repo/src/a.ts",
      line: 7,
      column: 3,
    })
  })

  test("a missing module is a runtime error", () => {
    const [diagnostic] = parseDiagnostics(
      ["error: Cannot find module 'left-pad' from '/app/src/a.ts'", "    at /app/src/a.ts:1:20"].join("\n"),
    )

    expect(diagnostic).toMatchObject({ kind: "runtime", file: "/app/src/a.ts", line: 1 })
  })

  test("empty or chatter-only output yields no diagnostics", () => {
    expect(parseDiagnostics("")).toEqual([])
    expect(parseDiagnostics("\n\n  \n")).toEqual([])
    expect(parseDiagnostics("$ bun test\n 5 pass\n 0 fail\nRan 5 tests across 1 file.\n")).toEqual([])
  })

  test("the same error printed twice is reported once", () => {
    const line = "src/a.ts(1,1): error TS1005: ';' expected."
    expect(parseDiagnostics([line, line].join("\n"))).toHaveLength(1)
  })
})

describe("summarize", () => {
  const diagnostics: Diagnostic[] = [
    {
      kind: "typescript",
      message: "Type 'string' is not assignable to type 'number'.",
      file: "src/a.ts",
      line: 12,
      column: 5,
      code: "TS2322",
    },
    {
      kind: "test",
      message: "sum > adds numbers",
      file: "src/sum.test.ts",
      line: 4,
      column: 9,
      expected: "2",
      actual: "1",
    },
  ]

  test("names the location, the code and what the assertion wanted", () => {
    const text = summarize(diagnostics)

    expect(text).toContain("2 diagnostic(s): 1 typescript, 1 test")
    expect(text).toContain("src/a.ts:12:5 TS2322 Type 'string' is not assignable to type 'number'.")
    expect(text).toContain("src/sum.test.ts:4:9 sum > adds numbers (expected 2, received 1)")
  })

  test("says so when there is nothing to summarize", () => {
    expect(summarize([])).toContain("printed no diagnostic")
  })

  test("a long list is clipped for the context window", () => {
    const many: Diagnostic[] = Array.from({ length: 40 }, (_, index) => ({
      kind: "typescript",
      message: `failure number ${index} with a fairly long explanation of what went wrong`,
      file: `src/file-${index}.ts`,
      line: index + 1,
    }))
    const text = summarize(many)

    expect(text.length).toBeLessThanOrEqual(2000)
    expect(text).toContain("and 30 more")
  })
})

describe("createHealingContext", () => {
  const diagnostics: Diagnostic[] = [
    { kind: "typescript", message: "boom", file: "src/a.ts", line: 1, column: 1, code: "TS2322" },
  ]

  test("a retry is allowed while attempts remain", () => {
    const context = createHealingContext({ diagnostics, attempt: 1, maxAttempts: 3, checkpointId: "cp_before" })

    expect(context.canRetry).toBe(true)
    expect(context.shouldRollback).toBe(false)
    expect(context.prompt).toContain("attempt 1 of 3")
    expect(context.prompt).toContain("src/a.ts:1:1 TS2322 boom")
    expect(context.prompt).toContain('restore checkpoint "cp_before"')
    expect(context.prompt).toContain("Never delete a test")
  })

  test("the last attempt is not retried and rolls back to the checkpoint", () => {
    const context = createHealingContext({ diagnostics, attempt: 3, maxAttempts: 3, checkpointId: "cp_before" })

    expect(context.canRetry).toBe(false)
    expect(context.shouldRollback).toBe(true)
    expect(context.prompt).toContain("last attempt (3 of 3)")
    expect(context.prompt).toContain('Restore checkpoint "cp_before"')
    expect(context.prompt).toContain("Stop editing")
  })

  test("without a checkpoint there is nothing to roll back to", () => {
    const context = createHealingContext({ diagnostics, attempt: 2, maxAttempts: 2 })

    expect(context.canRetry).toBe(false)
    expect(context.shouldRollback).toBe(false)
    expect(context.prompt).not.toContain("checkpoint tool")
    expect(context.prompt).toContain("report honestly")
  })

  test("an empty diagnostic list cannot be retried even with attempts left", () => {
    const context = createHealingContext({ diagnostics: [], attempt: 1, maxAttempts: 5, checkpointId: "cp_x" })

    expect(context.canRetry).toBe(false)
    expect(context.shouldRollback).toBe(true)
    expect(context.prompt).toContain("printed no diagnostic")
  })

  test("nonsense attempt counters are rejected", () => {
    expect(() => createHealingContext({ diagnostics, attempt: 0, maxAttempts: 3 })).toThrow(RangeError)
    expect(() => createHealingContext({ diagnostics, attempt: 1, maxAttempts: 0 })).toThrow(RangeError)
    expect(() => createHealingContext({ diagnostics, attempt: 1.5, maxAttempts: 3 })).toThrow(RangeError)
  })

  test("the summary is carried on the context", () => {
    const context = createHealingContext({ diagnostics, attempt: 1, maxAttempts: 2 })
    expect(context.summary).toContain("src/a.ts:1:1")
    expect(context.prompt).toContain(context.summary)
  })
})
