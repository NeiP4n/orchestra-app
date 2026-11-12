import { expect, test } from "bun:test"
import { ProjectTemplateImport } from "../src/project-template-import"
import { ProjectTemplate } from "../src/project-template"
import { ProjectTemplateV2 as V2 } from "../src/project-template-v2"
import { ProjectTemplateV2Runtime } from "../src/project-template-v2-runtime"
import { templateDiagnosticOf, templateError } from "../src/project-template-errors"
import { templateFixture } from "./project-template.test"
import { processFixture } from "./project-template-v2.test"

test("the actual destination role guard exposes a safe diagnostic and still refuses", () => {
  const bundle = templateFixture()
  const preview = ProjectTemplate.preview(JSON.stringify(bundle))
  if (!preview.ok) throw Error(preview.error)
  let failure: unknown
  try {
    ProjectTemplateImport.prepare(preview.value.text, {
      projectID: "prj_new",
      installedVersion: "1.0.0",
      reviewedDigest: preview.value.digest,
      now: 1,
      timezone: "UTC",
      sessions: { main: "ses_new" },
      browsers: { inbox: "brw_new" },
      schedules: { watch: "trg_new" },
      availableRoles: new Set(),
      availableModels: new Set(["demo/free"]),
    })
  } catch (error) {
    failure = error
  }
  expect(templateDiagnosticOf(failure)).toEqual({ stage: "roles", reasonCode: "session-role-missing" })
  expect(templateError(failure).kind).toBe("TEMPLATE_SESSION_ROLE")
})

for (const missingModel of [false, true])
  test(`v2 actual prepare distinguishes ${missingModel ? "model availability" : "core role mismatch"} without weakening equality`, async () => {
    const bundle = processFixture()
    const preview = V2.preview(JSON.stringify(bundle))
    if (!preview.ok) throw Error(preview.error)
    const roles = structuredClone(bundle.process.roles)
    if (!missingModel) roles[0].rules = "Different destination core rules"
    const adapter = ProjectTemplateV2Runtime.make({
      kv: {} as never,
      dataDirectory: process.cwd(),
      installedVersion: "1.0.0",
      changed: async () => {},
      destination: async () => ({
        roles,
        skills: [],
        models: new Set(missingModel ? [] : ["demo/free", "demo/free#careful", "demo/backup", "demo/backup#careful"]),
        programs: new Set(),
        mcp: new Map(),
        providers: new Set(),
      }),
    })
    const failure = await adapter.prepare(preview.value.text, preview.value.digest, "prj_new").then(
      () => undefined,
      (error) => error,
    )
    expect(templateError(failure).kind).toBe(missingModel ? "TEMPLATE_MODEL" : "TEMPLATE_CORE_ROLE")
    expect(templateDiagnosticOf(failure)).toEqual(
      missingModel
        ? { stage: "session-models", reasonCode: "model-unavailable" }
        : { stage: "roles", reasonCode: "core-role-different" },
    )
  })
