export * as ProjectTemplate from "./project-template.js"

import { createHash } from "node:crypto"
import { ProjectTemplateLinkReview } from "./project-template-link-review.js"
import { countSecrets } from "./memory/scrub.js"

/** Configuration only. No runtime identity, authority or secret values survive this boundary. */
export interface Bundle {
  format: "orchestra.project-template"
  version: 1
  name: string
  description: string
  minOrchestraVersion: string
  variables: { projectName: string; folder: "${projectFolder}" }
  mainSession?: string
  vault: { local: { name: string; type: "login" | "api-key" | "password"; label: string }[]; globalRequirements: string[] }
  sessions: { slot: string; title: string; role: string; model: { provider: string; id: string; variant: string | null } | null }[]
  browsers: { slot: string; name: string; mode: "headless" | "window" | "capture"; links: string[]; session?: string }[]
  rules: { session: string | null; text: string; scope?: "project" | "project-defaults" | "orchestrator" | "session" | "role"; role?: string }[]
  schedules: {
    slot: string
    source: { kind: "cron" | "interval" | "once"; spec: string; browser?: string } |
      { kind: "browser"; browser: string; match: string | null } |
      { kind: "execution.succeeded" | "execution.failed"; session: string }
    instruction: string
    maxPerHour: number
    maxPerDay: number
    missedPolicy: "skip" | "run-once" | "catch-up"
    structuredCondition?: true
  }[]
  providers: { id: string; endpoint: string | null; credentialSlots: string[] }[]
  mcp: { name: string; catalog: string; credentialSlots: string[] }[]
}
export type Result<T> = { ok: true; value: T } | { ok: false; error: string }
export const MAX_BYTES = 262_144
export const EXCLUDED = ["chats and session transcripts", "page text, DOM, screenshots, downloads and history", "cookies, profiles, logins, keys and credential bindings", "databases, memory, notes, lessons, metrics, tasks and logs", "runtime IDs, absolute paths, counters, permissions and grants", "MCP commands, arguments, environment values and startup scripts"] as const
export const WARNINGS = [
  "Skills, role definitions, model fallback lists, project files and global MCP settings are not copied. Review destination configuration.",
  "Review every included rule, instruction and link. Scanning detects known patterns, not every opaque secret or private fact.",
  "URL queries, fragments and credentials are rejected, never silently stripped.",
  "Import is staged only: no agent, browser, command, MCP connection or schedule starts.",
  "Rebind roles, models and credentials in the destination. All schedules remain paused.",
] as const
function invalid(): never { throw Error("Invalid project template configuration or unsupported fields.") }
function object(value: unknown, fields: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid()
  const row = value as Record<string, unknown>
  if (Object.keys(row).length !== fields.length || Object.keys(row).some((key) => !fields.includes(key))) invalid()
  return row
}
function array(value: unknown, max: number): unknown[] { if (!Array.isArray(value) || value.length > max) invalid(); return value }
function text(value: unknown, max = 4096): string {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) invalid()
  if (countSecrets(value) || /[?&](?:token|key|api[-_]?key|secret|password|signature)=[^&#\s]+/i.test(value) || /--?(?:api[-_]?key|token|password|secret)(?:=|\s+)\S+/i.test(value)) throw Error("Secret-like value detected. No template was prepared.")
  if (/(?:^|[\s"'=])(?:[A-Za-z]:[\\/]|\\\\|\/(?!\/)[^\s<>,;]*)/.test(value)) throw Error("Absolute paths are not portable. No template was prepared.")
  return value
}
function slot(value: unknown): string { const s = text(value, 40); if (!/^[a-z][a-z0-9_-]{0,39}$/.test(s)) invalid(); return s }
function id(value: unknown): string { const s = text(value, 120); if (!/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,119}$/.test(s)) invalid(); return s }
function unique(values: string[]) { if (new Set(values).size !== values.length) invalid() }
function slots(value: unknown) { const values = array(value, 20).map(slot); unique(values); return values }
function choice<T extends string>(value: unknown, values: readonly T[]): T { if (typeof value !== "string" || !values.includes(value as T)) invalid(); return value as T }
function cap(value: unknown, max: number): number { if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > max) invalid(); return value }
function url(value: unknown): string {
  const s = text(value, 2048), parsed = new URL(s)
  if (ProjectTemplateLinkReview.reason(s) || !['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw Error("Saved URLs require HTTP(S) with no credentials, query or fragment.")
  if (countSecrets(decodeURIComponent(parsed.pathname))) invalid()
  return s
}
function version(value: unknown): string { const s = text(value, 80); if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*)?$/.test(s)) invalid(); return s }

/** Closed schema. Errors never echo input, including JSON parser exceptions. */
export function parse(serialized: string): Result<Bundle> {
  if (Buffer.byteLength(serialized) > MAX_BYTES) return { ok: false, error: "Project template exceeds the size limit." }
  try {
    const raw: unknown = JSON.parse(serialized)
    const data = object(raw, ['format', 'version', 'name', 'description', 'minOrchestraVersion', 'variables', 'vault', 'sessions', 'browsers', 'rules', 'schedules', 'providers', 'mcp', ...(raw && typeof raw === 'object' && Object.hasOwn(raw, 'mainSession') ? ['mainSession'] : [])])
    if (data.format !== 'orchestra.project-template' || data.version !== 1) invalid()
    const variables = object(data.variables, ['projectName', 'folder']); if (variables.folder !== '${projectFolder}') invalid()
    const vault = object(data.vault, ['local', 'globalRequirements'])
    const local = array(vault.local, 100).map((v) => { const row = object(v, ['name', 'type', 'label']); return { name: slot(row.name), type: choice(row.type, ['login', 'api-key', 'password']), label: text(row.label, 160) } })
    unique(local.map((row) => row.name))
    const globalRequirements = array(vault.globalRequirements, 100).map(slot); unique(globalRequirements)
    if (globalRequirements.some((name) => local.some((row) => row.name === name))) invalid()
    const sessions = array(data.sessions, 100).map((v) => {
      const row = object(v, ['slot', 'title', 'role', 'model']), model = row.model === null ? null : object(row.model, ['provider', 'id', 'variant'])
      return { slot: slot(row.slot), title: text(row.title, 160), role: id(row.role), model: model === null ? null : { provider: id(model.provider), id: id(model.id), variant: model.variant === null ? null : id(model.variant) } }
    }); unique(sessions.map((row) => row.slot))
    const browsers = array(data.browsers, 50).map((v) => { const linked = !!v && typeof v === 'object' && Object.hasOwn(v, 'session'); const row = object(v, ['slot', 'name', 'mode', 'links', ...(linked ? ['session'] : [])]), links = array(row.links, 100).map(url); unique(links); return { slot: slot(row.slot), name: text(row.name, 160), mode: choice(row.mode, ['headless', 'window', 'capture']), links, ...(linked ? { session: slot(row.session) } : {}) } }); unique(browsers.map((row) => row.slot))
    const sessionNames = new Set(sessions.map((row) => row.slot)), browserNames = new Set(browsers.map((row) => row.slot))
    if (browsers.some((browser) => browser.session && !sessionNames.has(browser.session))) invalid()
    const mainSession = data.mainSession === undefined ? undefined : slot(data.mainSession)
    if (mainSession && !sessionNames.has(mainSession)) invalid()
    const sessionRef = (v: unknown) => { const s = slot(v); if (!sessionNames.has(s)) invalid(); return s }
    const rules: Bundle['rules'] = array(data.rules, 100).map((v) => {
      const hasScope = !!v && typeof v === "object" && Object.hasOwn(v, "scope")
      const hasRole = !!v && typeof v === "object" && Object.hasOwn(v, "role")
      const row = object(v, ['session', 'text', ...(hasScope ? ['scope'] : []), ...(hasRole ? ['role'] : [])])
      const session = row.session === null ? null : sessionRef(row.session), ruleText = text(row.text)
      if (!hasScope) { if (hasRole) invalid(); return { session, text: ruleText } }
      const scope = choice(row.scope, ['project', 'project-defaults', 'orchestrator', 'session', 'role'])
      if (scope === 'session' ? session === null : session !== null) invalid()
      if (scope === 'role') { if (!hasRole) invalid(); return { session: null, text: ruleText, scope, role: id(row.role) } }
      if (hasRole) invalid()
      return { session, text: ruleText, scope }
    })
    const schedules: Bundle['schedules'] = array(data.schedules, 20).map((v) => {
      const structured = !!v && typeof v === 'object' && Object.hasOwn(v, 'structuredCondition')
      const row = object(v, ['slot', 'source', 'instruction', 'maxPerHour', 'maxPerDay', 'missedPolicy', ...(structured ? ['structuredCondition'] : [])]), kind = (row.source as { kind?: unknown } | null)?.kind
      let source: Bundle['schedules'][number]['source']
      if (kind === 'browser') { const def = object(row.source, ['kind', 'browser', 'match']), browser = slot(def.browser); if (!browserNames.has(browser)) invalid(); source = { kind, browser, match: def.match === null ? null : text(def.match, 200) } }
      else if (kind === 'execution.succeeded' || kind === 'execution.failed') { const def = object(row.source, ['kind', 'session']); source = { kind, session: sessionRef(def.session) } }
      else {
        const bound = !!row.source && typeof row.source === 'object' && Object.hasOwn(row.source, 'browser')
        const def = object(row.source, ['kind', 'spec', ...(bound ? ['browser'] : [])]), k = choice(def.kind, ['cron', 'interval', 'once']), spec = text(def.spec, 120)
        if (k === 'interval' && (!/^\d{1,5}$/.test(spec) || Number(spec) < 5)) invalid()
        if (k === 'cron' && (!/^[0-9*/ ,\-]+$/.test(spec) || spec.trim().split(/\s+/).length !== 5)) invalid()
        if (k === 'once' && (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(spec) || !Number.isFinite(Date.parse(spec)))) invalid()
        if (bound && (k !== 'interval' || Number(spec) < 60 || !browserNames.has(slot(def.browser)))) invalid()
        source = { kind: k, spec, ...(bound ? { browser: slot(def.browser) } : {}) }
      }
      if (structured && row.structuredCondition !== true) invalid()
      return { ...(structured ? { structuredCondition: true as const } : {}), slot: slot(row.slot), source, instruction: text(row.instruction), maxPerHour: cap(row.maxPerHour, 12), maxPerDay: cap(row.maxPerDay, 100), missedPolicy: choice(row.missedPolicy, ['skip', 'run-once', 'catch-up']) }
    }); unique(schedules.map((row) => row.slot))
    const providers = array(data.providers, 30).map((v) => { const row = object(v, ['id', 'endpoint', 'credentialSlots']); return { id: id(row.id), endpoint: row.endpoint === null ? null : url(row.endpoint), credentialSlots: slots(row.credentialSlots) } }); unique(providers.map((row) => row.id))
    const mcp = array(data.mcp, 50).map((v) => { const row = object(v, ['name', 'catalog', 'credentialSlots']); return { name: slot(row.name), catalog: slot(row.catalog), credentialSlots: slots(row.credentialSlots) } }); unique(mcp.map((row) => row.name))
    const declared = new Set([...local.map((row) => row.name), ...globalRequirements]); if ([...mcp, ...providers].some((row) => row.credentialSlots.some((name) => !declared.has(name)))) invalid()
    return { ok: true, value: { format: 'orchestra.project-template', version: 1, name: text(data.name, 160), description: text(data.description, 2048), minOrchestraVersion: version(data.minOrchestraVersion), variables: { projectName: text(variables.projectName, 160), folder: '${projectFolder}' }, ...(mainSession ? { mainSession } : {}), vault: { local, globalRequirements }, sessions, browsers, rules, schedules, providers, mcp } }
  } catch (error) {
    const message = error instanceof Error ? error.message : ''
    return { ok: false, error: ['Secret-like value detected.', 'Absolute paths are not portable.', 'Saved URLs require HTTP(S)'].some((s) => message.startsWith(s)) ? message : 'Invalid project template configuration or unsupported fields.' }
  }
}
export function preview(serialized: string) {
  const parsed = parse(serialized); if (!parsed.ok) return parsed
  const bundle = parsed.value, text = JSON.stringify(bundle, null, 2) + '\n'
  if (Buffer.byteLength(text) > MAX_BYTES) return { ok: false as const, error: 'Formatted template exceeds the size limit.' }
  return { ok: true as const, value: { bundle, text, digest: createHash('sha256').update(text).digest('hex'), counts: { sessions: bundle.sessions.length, browsers: bundle.browsers.length, links: bundle.browsers.reduce((n, row) => n + row.links.length, 0), rules: bundle.rules.length, schedules: bundle.schedules.length, providers: bundle.providers.length, mcp: bundle.mcp.length, localVaultSlots: bundle.vault.local.length, globalRequirements: bundle.vault.globalRequirements.length }, excluded: EXCLUDED, warnings: WARNINGS } }
}
