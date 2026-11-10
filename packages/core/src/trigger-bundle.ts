export * as TriggerBundle from "./trigger-bundle.js"

import { Trigger } from "./trigger.js"

/** Portable schedules contain no instruction text, source identity, connection or execution state.
 * Instructions are explicit destination-project bindings, never copied from an imported file. */
export interface Template {
  slot: string
  secretSlots: string[]
  kind: "cron" | "interval" | "once"
  spec: string
  maxPerHour: number
  maxPerDay: number
  missedPolicy: "skip" | "run-once" | "catch-up"
}
export interface Prepared {
  trigger: Trigger.Info
  secretSlots: string[]
}

export interface Bundle {
  format: "orchestra.trigger-bundle"
  version: 1
  templates: Template[]
}
export type Result<T> = { ok: true; value: T } | { ok: false; error: string }
export const MAX_BYTES = 32_768
const fail = (error: string): Result<never> => ({ ok: false, error })
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
const keys = (value: Record<string, unknown>, expected: string[]) =>
  Object.keys(value).length === expected.length && Object.keys(value).every((key) => expected.includes(key))
const cap = (value: unknown, max: number): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= max
const slotPattern = /^template_[1-9][0-9]?$/
const specShape = (kind: Template["kind"], spec: string) => {
  if (kind === "interval") return /^[0-9]{1,5}$/.test(spec)
  if (kind === "cron") return /^[0-9*/,\s-]{9,100}$/.test(spec)
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(spec)
}

export function parse(text: string): Result<Bundle> {
  if (new TextEncoder().encode(text).byteLength > MAX_BYTES) return fail("Trigger bundle is too large.")
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return fail("Trigger bundle is not JSON.")
  }
  if (
    !object(data) ||
    !keys(data, ["format", "version", "templates"]) ||
    data.format !== "orchestra.trigger-bundle" ||
    data.version !== 1
  )
    return fail("Unsupported trigger bundle format or fields.")
  if (
    !Array.isArray(data.templates) ||
    data.templates.length < 1 ||
    data.templates.length > Trigger.MAX_TRIGGERS_PER_PROJECT
  )
    return fail("A bundle needs 1-20 templates.")
  const templates: Template[] = []
  const seen = new Set<string>()
  for (const row of data.templates) {
    if (!object(row) || !keys(row, ["slot", "secretSlots", "kind", "spec", "maxPerHour", "maxPerDay", "missedPolicy"]))
      return fail("Unknown trigger template fields. Runtime state, instructions and credentials are not portable.")
    if (typeof row.slot !== "string" || !slotPattern.test(row.slot) || seen.has(row.slot))
      return fail("Invalid or duplicate template slot.")
    if (row.kind !== "cron" && row.kind !== "interval" && row.kind !== "once")
      return fail("This bundle version supports time sources only.")
    if (typeof row.spec !== "string" || !specShape(row.kind, row.spec)) return fail("Invalid schedule specification.")
    if (!cap(row.maxPerHour, Trigger.HARD_PER_HOUR) || !cap(row.maxPerDay, Trigger.HARD_PER_DAY))
      return fail("Invalid trigger caps.")
    if (row.missedPolicy !== "skip" && row.missedPolicy !== "run-once" && row.missedPolicy !== "catch-up")
      return fail("Invalid missed policy.")
    if (
      !Array.isArray(row.secretSlots) ||
      row.secretSlots.length > 10 ||
      row.secretSlots.some((slot) => typeof slot !== "string" || !/^[a-z][a-z0-9_.-]{0,39}$/.test(slot)) ||
      new Set(row.secretSlots).size !== row.secretSlots.length
    )
      return fail("Secret requirements must be unique slot names, never values.")
    seen.add(row.slot)
    templates.push({
      slot: row.slot,
      secretSlots: row.secretSlots,
      kind: row.kind,
      spec: row.spec,
      maxPerHour: row.maxPerHour,
      maxPerDay: row.maxPerDay,
      missedPolicy: row.missedPolicy,
    })
  }
  return { ok: true, value: { format: "orchestra.trigger-bundle", version: 1, templates } }
}

export function fromTriggers(triggers: readonly Trigger.Info[]): Result<Bundle> {
  const templates: Template[] = []
  for (const trigger of triggers) {
    if (
      !["cron", "interval", "once"].includes(trigger.kind) ||
      trigger.browserSessionID ||
      trigger.localTest ||
      trigger.actions?.length
    )
      return fail(
        "This bundle version cannot transfer event/browser bindings or local action plans. Nothing was exported.",
      )
    if (trigger.maxPerHour === null || trigger.maxPerHour > Trigger.HARD_PER_HOUR)
      return fail("An operator-unlimited schedule needs an explicit portable cap. Nothing was exported.")
    templates.push({
      slot: `template_${templates.length + 1}`,
      secretSlots: [],
      kind: trigger.kind as Template["kind"],
      spec: trigger.spec,
      maxPerHour: trigger.maxPerHour,
      maxPerDay: trigger.maxPerDay,
      missedPolicy: trigger.missedPolicy ?? "skip",
    })
  }
  return parse(JSON.stringify({ format: "orchestra.trigger-bundle", version: 1, templates }))
}

/** Prepare the entire import before any writes. The caller must persist as one project operation.
 * Always paused; imported data cannot start agents, reset existing caps or grant publishing rights. */
export function instantiate(
  text: string,
  context: {
    projectID: string
    now: number
    timezone: string
    existing: number
    bindings: Readonly<Record<string, { id: string; prompt: string }>>
    /** Names whose destination-project vault references the caller has actually verified. No values. */
    boundSecretSlots?: ReadonlySet<string>
  },
): Result<Prepared[]> {
  const parsed = parse(text)
  if (!parsed.ok) return parsed
  if (
    !context.projectID.trim() ||
    !Number.isFinite(context.now) ||
    !Number.isInteger(context.existing) ||
    context.existing < 0
  )
    return fail("An exact destination project and valid import context are required.")
  if (context.existing + parsed.value.templates.length > Trigger.MAX_TRIGGERS_PER_PROJECT)
    return fail("Destination project trigger limit exceeded.")
  if (Object.keys(context.bindings).length !== parsed.value.templates.length)
    return fail("Bind every instruction slot exactly once.")
  const missing = [...new Set(parsed.value.templates.flatMap((template) => template.secretSlots))].filter(
    (slot) => !context.boundSecretSlots?.has(slot),
  )
  if (missing.length)
    return fail(
      `Secret slots not bound in the selected project: ${missing.join(", ")}. No trigger was created or enabled.`,
    )
  const ids = new Set<string>()
  const result: Prepared[] = []
  for (const template of parsed.value.templates) {
    const binding = Object.hasOwn(context.bindings, template.slot) ? context.bindings[template.slot] : undefined
    if (
      !binding ||
      !/^trg_[A-Za-z0-9_-]{1,100}$/.test(binding.id) ||
      ids.has(binding.id) ||
      typeof binding.prompt !== "string"
    )
      return fail("Every slot needs a new unique destination trigger ID and instruction.")
    ids.add(binding.id)
    const created = Trigger.create({ ...template, prompt: binding.prompt }, { ...context, id: binding.id })
    if (!created.ok) return fail(created.error)
    result.push({
      trigger: {
        ...created.trigger,
        enabled: false,
        pausedReason: "Imported template: review the instruction and resume in this project.",
      },
      secretSlots: [...template.secretSlots],
    })
  }
  return { ok: true, value: result }
}
