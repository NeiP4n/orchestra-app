import { expect, test } from "bun:test"
import { mkdtemp, rm, mkdir, writeFile, readFile, symlink, link, readdir } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { ProjectTemplate } from "../src/project-template"
import { ProjectTemplateFiles as Files } from "../src/project-template-files"
const fixture = (): ProjectTemplate.Bundle => ({ format: 'orchestra.project-template', version: 1, name: 'Factory', description: 'Configuration only', minOrchestraVersion: '1.0.0', variables: { projectName: 'Factory', folder: '${projectFolder}' }, vault: { local: [{ name: 'api', type: 'api-key', label: 'API account' }], globalRequirements: ['global-api'] }, sessions: [{ slot: 'main', title: 'Main', role: 'orchestrator', model: null }], browsers: [{ slot: 'page', name: 'Page', mode: 'window', links: ['https://example.com/'] }], rules: [], schedules: [{ slot: 'hour', source: { kind: 'interval', spec: '60' }, instruction: 'Review new work.', maxPerHour: 6, maxPerDay: 48, missedPolicy: 'skip' }], providers: [], mcp: [] })
function preview(input = fixture()) { const result = ProjectTemplate.preview(JSON.stringify(input)); if (!result.ok) throw Error(result.error); return result.value }
async function temporary(run: (directory: string) => Promise<void>) { const root = await mkdtemp(path.join(os.tmpdir(), 'template-test-')); try { await run(root) } finally { await rm(root, { recursive: true, force: true }) } }
test('save, review and staged import preserve exact bytes but never create live stores or start anything', () => temporary(async (root) => {
  const p = preview(), saved = await Files.save(root, 'factory', p.text, p.digest)
  expect((await Files.load(saved.directory)).text).toBe(p.text)
  const project = path.join(root, 'project'); await mkdir(project)
  const staged = await Files.stage(saved.directory, project, 'factory', p.digest, '1.0.0')
  expect(staged.checklist.active).toBe(false)
  expect(staged.checklist.localVaultSlots[0].state).toBe('empty')
  expect(staged.checklist.globalVaultSlots[0].state).toBe('binding-required')
  expect(staged.checklist.schedules[0].state).toContain('paused')
  expect(staged.checklist.browsers[0].state).toContain('not-opened')
  expect(await readdir(path.join(project, '.orchestra'))).toEqual(['template-imports'])
  expect(await readFile(path.join(staged.directory, Files.FILE), 'utf8')).toBe(p.text)
}))
test('save never overwrites an existing or empty folder and binds reviewed content', () => temporary(async (root) => {
  const p = preview(); await Files.save(root, 'factory', p.text, p.digest)
  await expect(Files.save(root, 'factory', p.text, p.digest)).rejects.toThrow()
  await mkdir(path.join(root, 'empty')); await expect(Files.save(root, 'empty', p.text, p.digest)).rejects.toThrow()
  await expect(Files.save(root, 'changed', p.text, 'bad-digest')).rejects.toThrow('preview')
  for (const name of ['../escape', '/tmp/escape', 'C:\\escape', 'a/b', '.']) await expect(Files.save(root, name, p.text, p.digest)).rejects.toThrow()
}))
test('source folder cannot smuggle chat, cookies, scripts, links or oversized files', () => temporary(async (root) => {
  const p = preview(), saved = await Files.save(root, 'factory', p.text, p.digest)
  await writeFile(path.join(saved.directory, 'messages.json'), 'PRIVATE-CANARY')
  await expect(Files.load(saved.directory)).rejects.toThrow('only template.json')
  await rm(path.join(saved.directory, 'messages.json'))
  await rm(path.join(saved.directory, Files.FILE)); await writeFile(path.join(root, 'outside'), p.text)
  await symlink(path.join(root, 'outside'), path.join(saved.directory, Files.FILE)); await expect(Files.load(saved.directory)).rejects.toThrow('regular file')
  await rm(path.join(saved.directory, Files.FILE)); await link(path.join(root, 'outside'), path.join(saved.directory, Files.FILE)); await expect(Files.load(saved.directory)).rejects.toThrow('regular file')
  await rm(path.join(saved.directory, Files.FILE)); await writeFile(path.join(saved.directory, Files.FILE), 'x'.repeat(ProjectTemplate.MAX_BYTES + 1)); await expect(Files.load(saved.directory)).rejects.toThrow('bounded')
}))
test('failed compatibility or changed review writes no import folder and symlink destination is denied', () => temporary(async (root) => {
  const p = preview(), saved = await Files.save(root, 'factory', p.text, p.digest), project = path.join(root, 'project'); await mkdir(project)
  await expect(Files.stage(saved.directory, project, 'factory', p.digest, '0.9.9')).rejects.toThrow('newer')
  await expect(Files.stage(saved.directory, project, 'factory', 'bad', '1.0.0')).rejects.toThrow('preview')
  expect(await readdir(project)).toEqual([])
  await symlink(root, path.join(project, '.orchestra')); await expect(Files.stage(saved.directory, project, 'factory', p.digest, '1.0.0')).rejects.toThrow('symbolic')
}))
test('compatibility is numeric and prerelease never guessed', () => {
  Files.checkCompatibility(fixture(), '1.10.0')
  const input = fixture(); input.minOrchestraVersion = '1.10.0'
  expect(() => Files.checkCompatibility(input, '1.9.9')).toThrow('newer')
  expect(() => Files.checkCompatibility(input, '1.10.0-beta')).toThrow('stable')
})
test('update review is add/unchanged/conflict, never writes or mutates existing definitions', () => {
  const a = fixture(), b = fixture(); b.sessions[0].title = 'Changed'; b.browsers.push({ slot: 'second', name: 'Second', mode: 'window', links: [] })
  const before = JSON.stringify(a), diff = Files.compare(a, b)
  expect(diff).toContainEqual({ section: 'sessions', slot: 'main', status: 'conflict' })
  expect(diff).toContainEqual({ section: 'browsers', slot: 'second', status: 'add' })
  expect(diff).toContainEqual({ section: 'schedules', slot: 'hour', status: 'unchanged' })
  expect(JSON.stringify(a)).toBe(before)
})

test('update includes rule, Vault, metadata differences and preserves omitted existing entries', () => {
  const a = fixture(), b = fixture(); a.rules = [{ session: null, text: 'Original rule' }]; b.rules = [{ session: null, text: 'New rule' }]
  b.vault.local[0].label = 'Different label'; b.description = 'Different description'; b.browsers = []
  const diff = Files.compare(a, b)
  for (const section of ['rules', 'localVault', 'metadata']) expect(diff.some((entry) => entry.section === section && entry.status === 'conflict')).toBe(true)
  expect(diff).toContainEqual({ section: 'browsers', slot: 'page', status: 'preserve-existing' })
})
