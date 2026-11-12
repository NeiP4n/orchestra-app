import { expect, test } from "bun:test"
import { templateError, templateErrorKey, type TemplateErrorCode } from "../src/project-template-errors"
test("public template errors carry bounded codes without exception contents", () => {
  for (const code of ["EACCES", "EPERM", "EROFS"]) {
    const error = Object.assign(new Error("PRIVATE_PATH /private/data and private_token"), { code })
    expect(templateError(error).kind).toBe("TEMPLATE_PERMISSION")
    expect(JSON.stringify(templateError(error))).not.toMatch(/PRIVATE_PATH|private_token/)
  }
  expect(templateError(Object.assign(new Error("private"), { code: "ENOENT" })).kind).toBe("TEMPLATE_MISSING")
  expect(templateError(new Error("Project changed during capture.")).kind).toBe("TEMPLATE_CHANGED")
  expect(templateError(new Error("unknown PRIVATE_CANARY")).kind).toBe("TEMPLATE_FAILED")
  expect(templateError({ message: "Project changed during capture." }).kind).toBe("TEMPLATE_FAILED")
  expect(templateErrorKey(new Error("PRIVATE_CANARY"))).toBeUndefined()
  const declared = Object.assign(new Error("PRIVATE_CANARY"), { _tag: "InvalidRequestError", kind: "TEMPLATE_CHANGED" })
  expect(templateErrorKey(declared)).toBe(templateError(new Error("Project changed during capture.")).message)
  expect(templateErrorKey(Object.assign(declared, { kind: "UNKNOWN" }))).toBeUndefined()
})


test("ownership failures have separate safe public reasons without echoing source identifiers", () => {
  const messages: ReadonlyArray<readonly [string, TemplateErrorCode]> = [
    ["Project main session is not initialized.", "TEMPLATE_MAIN_UNSET"],
    ["Project main session is missing.", "TEMPLATE_MAIN_MISSING"],
    ["Project main session points to a child task.", "TEMPLATE_MAIN_CHILD"],
    ["Project main session belongs to another project.", "TEMPLATE_MAIN_FOREIGN"],
    ["A top-level session has conflicting project ownership.", "TEMPLATE_SESSION_CONFLICT"],
    ["Browser ownership or identity is invalid.", "TEMPLATE_BROWSER_OWNER"],
  ]
  for (const [message, kind] of messages) {
    const result = templateError(new Error(message))
    expect(result.kind).toBe(kind)
    expect(result.message).not.toContain("metadata is incomplete")
    expect(result.message).not.toMatch(/ses_|prj_|[A-Za-z]:\\|PRIVATE/)
  }
})

test("actual v1 and v2 library guards preserve invalid-name rejection and bounded diagnosis", async () => {
  const { ProjectTemplateLibrary } = await import("../src/project-template-library")
  const { ProjectTemplateV2Library } = await import("../src/project-template-v2-library")
  const { templateDiagnosticOf } = await import("../src/project-template-errors")
  const { mkdtemp, rm, realpath } = await import("node:fs/promises")
  const { tmpdir } = await import("node:os")
  const path = await import("node:path")
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "template-name-")))
  try {
    for (const library of [ProjectTemplateLibrary.local(root), ProjectTemplateV2Library.local(root)]) {
      for (const name of ["83_PRIVATE_CANARY", "../PRIVATE_CANARY", "", "Uppercase", "a".repeat(61)]) {
        const failure = await library.preview(name).then(() => undefined, error => error)
        expect(templateError(failure).kind).toBe("TEMPLATE_NAME")
        expect(templateDiagnosticOf(failure)).toEqual({ stage: "template-name", reasonCode: "name-invalid" })
        expect(JSON.stringify(templateError(failure))).not.toContain("PRIVATE_CANARY")
      }
      const missing = await library.preview("template_83c365").then(() => undefined, error => error)
      expect(templateError(missing).kind).toBe("TEMPLATE_MISSING")
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})
