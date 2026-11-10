export * as ProjectTemplateImport from "./project-template-import.js"

import { ProjectTemplate } from "./project-template.js"
import { ProjectTemplateFiles } from "./project-template-files.js"
import { Trigger } from "./trigger.js"

/** All identities come from a fresh destination reservation, never from imported bytes.
 * This prepares definitions only. A caller must not advertise completion until its actual
 * stores have committed and verified every definition, or recorded recoverable partial state. */
export interface Destination {
  projectID: string
  installedVersion: string
  reviewedDigest: string
  now: number
  timezone: string
  sessions: Readonly<Record<string, string>>
  browsers: Readonly<Record<string, string>>
  schedules: Readonly<Record<string, string>>
  availableRoles: ReadonlySet<string>
  /** provider/model#variant, no variant suffix when absent. Existence is not execution permission. */
  availableModels: ReadonlySet<string>
}
function exactKeys(map: Readonly<Record<string, string>>, expected: readonly string[]) {
  if (Object.keys(map).length !== expected.length || expected.some((slot) => !Object.hasOwn(map, slot)))
    throw Error("Every destination slot requires an exact fresh identity.")
}
function identity(value: string, prefix: string) {
  if (!value.startsWith(prefix) || !/^[A-Za-z0-9_-]{1,120}$/.test(value)) throw Error("Invalid destination identity.")
  return value
}
export function prepare(serialized: string, destination: Destination) {
  const preview = ProjectTemplate.preview(serialized)
  if (!preview.ok) throw Error(preview.error)
  if (preview.value.digest !== destination.reviewedDigest) throw Error("Template changed after review.")
  ProjectTemplateFiles.checkCompatibility(preview.value.bundle, destination.installedVersion)
  if (!/^prj[A-Za-z0-9_-]+$/.test(destination.projectID) || !Number.isFinite(destination.now))
    throw Error("Fresh destination project required.")
  try {
    new Intl.DateTimeFormat("en", { timeZone: destination.timezone }).format(destination.now)
  } catch {
    throw Error("Exact destination timezone required.")
  }
  const bundle = preview.value.bundle
  exactKeys(
    destination.sessions,
    bundle.sessions.map((row) => row.slot),
  )
  exactKeys(
    destination.browsers,
    bundle.browsers.map((row) => row.slot),
  )
  exactKeys(
    destination.schedules,
    bundle.schedules.map((row) => row.slot),
  )
  const identities = [
    ...Object.values(destination.sessions).map((id) => identity(id, "ses")),
    ...Object.values(destination.browsers).map((id) => identity(id, "brw_")),
    ...Object.values(destination.schedules).map((id) => identity(id, "trg_")),
  ]
  if (new Set(identities).size !== identities.length) throw Error("Destination identities must be unique.")
  const sessions = bundle.sessions.map((row) => {
    if (!destination.availableRoles.has(row.role)) throw Error("A required role is unavailable in the destination.")
    const model = row.model
      ? `${row.model.provider}/${row.model.id}${row.model.variant ? "#" + row.model.variant : ""}`
      : null
    if (model && !destination.availableModels.has(model))
      throw Error("A required model is unavailable in the destination.")
    return {
      id: destination.sessions[row.slot],
      slot: row.slot,
      title: row.title,
      role: row.role,
      model: row.model,
      messages: [] as never[],
      inheritedPermissions: false as const,
    }
  })
  const mainSlot = bundle.mainSession ?? (bundle.sessions.filter((row) => row.role === "orchestrator").length === 1 ? bundle.sessions.find((row) => row.role === "orchestrator")!.slot : undefined)
  if (mainSlot && bundle.sessions.find((row) => row.slot === mainSlot)?.role !== "orchestrator") throw Error("The destination main session must be an Orchestrator.")
  if (bundle.browsers.some((row) => row.session && bundle.sessions.find((session) => session.slot === row.session)?.role !== "team-browser-agent")) throw Error("Browser slots require their own BrowserAgent session.")
  if (new Set(bundle.browsers.flatMap((row) => row.session ? [row.session] : [])).size !== bundle.browsers.filter((row) => row.session).length) throw Error("A BrowserAgent session cannot be inherited by two browsers.")
  const browsers = bundle.browsers.map((row) => ({
    id: destination.browsers[row.slot],
    slot: row.slot,
    name: row.name,
    mode: row.mode,
    savedLinks: [...row.links],
    ...(row.session ? { chat: destination.sessions[row.session] } : {}),
    state: "not-opened" as const,
    login: "required" as const,
    profile: "new" as const,
  }))
  const counts = new Map<string, number>()
  const rules = bundle.rules.map((row) => {
    const scope = row.scope ?? (row.session ? "session" : "project")
    if (scope === "role" && (!row.role || !destination.availableRoles.has(row.role)))
      throw Error("A rule references an unavailable destination role.")
    const key =
      scope === "session"
        ? `session:${destination.sessions[row.session!]}`
        : scope === "role"
          ? `role:${destination.projectID}:${row.role}`
          : `${scope}:${destination.projectID}`
    const count = (counts.get(key) ?? 0) + 1
    counts.set(key, count)
    if (count > 20 || row.text.length > 240 || !row.text.trim())
      throw Error("Destination rule limits would change or truncate the imported rule.")
    return { scope: key, text: row.text }
  })
  const schedules: Trigger.Info[] = bundle.schedules.map((row, index) => {
    if (row.source.kind === "execution.succeeded" || row.source.kind === "execution.failed")
      throw Error("This destination cannot import internal events without a reviewed local action plan.")
    const kind = row.source.kind,
      spec =
        kind === "browser"
          ? destination.browsers[(row.source as { browser: string }).browser]
          : (row.source as { spec: string }).spec
    const expectedCondition = row.structuredCondition
      ? kind === "browser"
        ? { type: "browser" as const, event: "incoming-row" as const, sessionID: spec, ...("match" in row.source && row.source.match ? { match: row.source.match } : {}) }
        : { type: "time" as const, kind: kind as "cron" | "interval" | "once", spec }
      : undefined
    const expectedBrowser = "browser" in row.source && kind === "interval" ? destination.browsers[row.source.browser!] : undefined
    const expectedMatch = kind === "browser" && "match" in row.source ? row.source.match ?? undefined : undefined
    const created = Trigger.create(
      {
        ...(expectedCondition ? { condition: expectedCondition } : {}),
        kind,
        spec,
        prompt: row.instruction,
        maxPerHour: row.maxPerHour,
        maxPerDay: row.maxPerDay,
        missedPolicy: row.missedPolicy,
        ...("browser" in row.source && kind === "interval" ? { browserSessionID: destination.browsers[row.source.browser!] } : {}),
        ...(kind === "browser" && "match" in row.source && row.source.match ? { match: row.source.match } : {}),
      },
      {
        id: destination.schedules[row.slot],
        projectID: destination.projectID,
        now: destination.now,
        timezone: destination.timezone,
        existing: index,
      },
    )
    if (!created.ok) throw Error("Schedule cannot be represented unchanged in the destination. Nothing was prepared.")
    const trigger = created.trigger
    if (
      trigger.kind !== kind || trigger.spec !== spec || trigger.match !== expectedMatch ||
      trigger.browserSessionID !== expectedBrowser || trigger.missedPolicy !== row.missedPolicy ||
      JSON.stringify(trigger.condition) !== JSON.stringify(expectedCondition) ||
      trigger.prompt !== row.instruction ||
      trigger.maxPerHour !== row.maxPerHour ||
      trigger.maxPerDay !== row.maxPerDay
    )
      throw Error("Schedule would be changed during import.")
    return {
      ...trigger,
      enabled: false,
      nextAt: null,
      publishApproved: false,
      pausedReason: kind === "browser" || "browser" in row.source
        ? "Нужна привязка заново: откройте нужную страницу в новом браузере, войдите в аккаунт и проверьте чат/страницу. Затем включите отдельно. Вход и исходные ссылки не наследуются."
        : "Импортирован из шаблона. Проверьте инструкцию и учётные данные, затем включите отдельно.",
    }
  })
  return {
    digest: preview.value.digest,
    projectID: destination.projectID,
    mainSessionID: mainSlot ? destination.sessions[mainSlot] : undefined,
    sessions,
    browsers,
    rules,
    schedules,
    localVaultSlots: bundle.vault.local.map((row) => ({
      name: row.name,
      type: row.type,
      label: row.label,
      state: "empty" as const,
      allowedSessionIDs: [] as string[],
    })),
    globalRequirements: bundle.vault.globalRequirements.map((name) => ({ name, state: "binding-required" as const })),
    integrationRequirements: { providers: bundle.providers, mcp: bundle.mcp },
    started: false as const,
  }
}
