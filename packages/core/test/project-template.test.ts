import { expect, test } from "bun:test"
import { ProjectTemplate } from "../src/project-template"
export const templateFixture = (): ProjectTemplate.Bundle => ({
  format: "orchestra.project-template", version: 1, name: "Factory", description: "Reusable configuration", minOrchestraVersion: "1.0.0",
  variables: { projectName: "Factory", folder: "${projectFolder}" },
  vault: { local: [{ name: "service", type: "api-key", label: "Service key" }], globalRequirements: ["shared"] },
  sessions: [{ slot: "main", title: "Main", role: "orchestrator", model: { provider: "demo", id: "free", variant: null } }],
  browsers: [{ slot: "inbox", name: "Inbox", mode: "window", links: ["https://example.com/inbox"] }],
  rules: [{ session: null, text: "Review each result. Publishing requires approval." }],
  schedules: [{ slot: "watch", source: { kind: "browser", browser: "inbox", match: null }, instruction: "Report new items for review.", maxPerHour: 6, maxPerDay: 48, missedPolicy: "skip" }],
  providers: [{ id: "demo", endpoint: "https://example.com/v1", credentialSlots: ["service"] }],
  mcp: [{ name: "docs", catalog: "context7", credentialSlots: [] }],
})
const parse = (v: unknown) => ProjectTemplate.parse(JSON.stringify(v))
test("roundtrip preserves exact definitions, preview binds exact bytes without granting authority", () => {
  const input = templateFixture(), result = ProjectTemplate.preview(JSON.stringify(input))
  expect(result.ok).toBe(true); if (!result.ok) throw Error(result.error)
  expect(result.value.bundle).toEqual(input)
  expect(parse(JSON.parse(result.value.text))).toEqual({ ok: true, value: input })
  expect(result.value.digest).toMatch(/^[a-f0-9]{64}$/)
  expect(result.value.counts).toEqual({ sessions: 1, browsers: 1, links: 1, rules: 1, schedules: 1, providers: 1, mcp: 1, localVaultSlots: 1, globalRequirements: 1 })
  expect(result.value.warnings.join(' ')).toContain('not every opaque secret')
  expect(result.value.text).not.toContain('"enabled"'); expect(result.value.text).not.toContain('"blob"')
})
for (const field of ['messages', 'history', 'cookies', 'pageText', 'database', 'permissions', 'grants', 'absolutePath', 'profile', 'secret', 'access_token'])
  test(`rejects unknown ${field} without echo`, () => { const r = parse({ ...templateFixture(), [field]: "PRIVATE-CANARY" }); expect(r.ok).toBe(false); expect(JSON.stringify(r)).not.toContain('PRIVATE-CANARY') })
for (const value of ['sk-abcdefghijk123456', 'password=hunter2', 'Bearer abcdefghijk123456', '--token opaque-value', 'https://user:password@example.com', 'https://example.com/?token=opaque', 'C:\\Users\\private\\cookies', '/home/user/private'])
  test(`rejects secret/path canary ${value.slice(0, 8)}`, () => { const input = templateFixture(); input.rules[0].text = value; const r = parse(input); expect(r.ok).toBe(false); expect(JSON.stringify(r)).not.toContain(value) })
for (const link of ['file:///tmp/private', 'javascript:alert(1)', 'https://example.com/?q=private', 'https://example.com/#private', 'https://user@example.com', 'https://example.com/sk-abcdefghijk123456', 'https://example.com/%73k-abcdefghijk123456'])
  test(`rejects unsafe URL ${link.slice(0, 22)}`, () => { const input = templateFixture(); input.browsers[0].links = [link]; expect(parse(input).ok).toBe(false) })
test("nested runtime data, executable MCP and secret values cannot enter", () => {
  for (const [target, field] of [['sessions', 'messages'], ['browsers', 'cookies'], ['schedules', 'enabled'], ['providers', 'apiKey'], ['mcp', 'command']] as const) { const input = templateFixture(); Object.assign(input[target][0], { [field]: 'PRIVATE-CANARY' }); expect(parse(input).ok).toBe(false) }
  const input = templateFixture(); Object.assign(input.vault.local[0], { value: 'PRIVATE-CANARY' }); expect(parse(input).ok).toBe(false)
})
test("all slot references resolve locally, are unique and bounded", () => {
  const input = templateFixture(); input.schedules[0].source = { kind: 'browser', browser: 'other', match: null }; expect(parse(input).ok).toBe(false)
  input.schedules[0].source = { kind: 'execution.succeeded', session: 'main' }; expect(parse(input).ok).toBe(true)
  input.sessions.push(input.sessions[0]); expect(parse(input).ok).toBe(false)
})
test("closed format metadata, malformed JSON and size limits fail without content echo", () => {
  for (const update of [{ version: 2 }, { format: 'backup' }, { minOrchestraVersion: 'latest' }, { variables: { projectName: 'x', folder: '/tmp/x' } }, { sessions: Array(101).fill(templateFixture().sessions[0]) }]) expect(parse({ ...templateFixture(), ...update }).ok).toBe(false)
  expect(ProjectTemplate.parse('{"PRIVATE-CANARY":').ok).toBe(false); expect(JSON.stringify(ProjectTemplate.parse('{"PRIVATE-CANARY":'))).not.toContain('PRIVATE-CANARY')
  expect(ProjectTemplate.parse(' '.repeat(ProjectTemplate.MAX_BYTES + 1)).ok).toBe(false)
})
test("empty slots and missing global names cannot collide; references must be declared", () => {
  const input = templateFixture(); input.vault.globalRequirements.push('service'); expect(parse(input).ok).toBe(false)
  input.vault.globalRequirements = ['shared']; input.providers[0].credentialSlots.push('undeclared'); expect(parse(input).ok).toBe(false)
  input.providers[0].credentialSlots = ['shared']; expect(parse(input).ok).toBe(true)
})
test("explicit rule scopes preserve defaults, orchestrator, role and session boundaries without flattening", () => {
  const input = templateFixture()
  input.rules = [
    { scope: "project", session: null, text: "Project rule" },
    { scope: "project-defaults", session: null, text: "Default copy" },
    { scope: "orchestrator", session: null, text: "Orchestrator rule" },
    { scope: "role", role: "builder", session: null, text: "Builder rule" },
    { scope: "session", session: "main", text: "Exact session rule" },
  ]
  expect(parse(input)).toEqual({ ok: true, value: input })
  const bad = [
    { scope: "global", session: null, text: "Rule" },
    { scope: "role", session: null, text: "Rule" },
    { scope: "session", session: null, text: "Rule" },
    { scope: "project", session: "main", text: "Rule" },
    { scope: "orchestrator", session: null, role: "builder", text: "Rule" },
  ]
  for (const rule of bad) expect(parse({ ...input, rules: [rule] }).ok).toBe(false)
})
