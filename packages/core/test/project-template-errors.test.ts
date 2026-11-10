import { expect, test } from "bun:test"
import { templateError, templateErrorKey } from "../src/project-template-errors"
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
