import { describe, expect, test } from "bun:test"
import { RuleEnforce } from "@orchestra/core/rule-enforce"

const rule = (text: string, by = "operator") => ({ title: "Project", text, by })

describe("RuleEnforce hard layer", () => {
  test("deny tool, for a role and for everyone", () => {
    const entries = [rule("deny tool playwright_* for role developer")]
    expect(RuleEnforce.violation(entries, { tool: "playwright_click", agent: "team-developer", input: {} })).toBeDefined()
    expect(RuleEnforce.violation(entries, { tool: "playwright_click", agent: "team-tester", input: {} })).toBeUndefined()
    expect(RuleEnforce.violation([rule("deny tool shell")], { tool: "shell", agent: "x", input: {} })).toBeDefined()
  })
  test("only a role may use a tool", () => {
    const entries = [rule("only role browser-agent may use tool browser")]
    expect(RuleEnforce.violation(entries, { tool: "browser", agent: "team-browser-agent", input: {} })).toBeUndefined()
    expect(RuleEnforce.violation(entries, { tool: "browser", agent: "team-developer", input: {} })).toBeDefined()
  })
  test("deny command and deny path", () => {
    expect(RuleEnforce.violation([rule("deny command git push --force")], { tool: "shell", agent: "a", input: { command: "git push --force origin dev" } })).toBeDefined()
    expect(RuleEnforce.violation([rule("deny command git push --force")], { tool: "shell", agent: "a", input: { command: "git status" } })).toBeUndefined()
    expect(RuleEnforce.violation([rule("deny path **/.env")], { tool: "read", agent: "a", input: { path: "/x/y/.env" } })).toBeDefined()
    expect(RuleEnforce.violation([rule("deny path **/.env")], { tool: "read", agent: "a", input: { path: "/x/y/main.ts" } })).toBeUndefined()
  })
  test("the rules tool is never refused, and plain rules are not directives", () => {
    expect(RuleEnforce.violation([rule("deny tool *")], { tool: "rules", agent: "a", input: {} })).toBeUndefined()
    expect(RuleEnforce.isDirective("Keep answers short.")).toBe(false)
    expect(RuleEnforce.isDirective("deny tool shell")).toBe(true)
  })
  test("the operator's rule is the one quoted when two apply", () => {
    const hit = RuleEnforce.violation([rule("deny tool shell", "team-orchestrator"), rule("deny tool shell")], { tool: "shell", agent: "a", input: {} })
    expect(hit?.by).toBe("operator")
    expect(RuleEnforce.refusal(hit!)).toContain("deny tool shell")
  })
})

describe("RuleEnforce judge verdict", () => {
  const entries = [rule("Ask before spending money."), rule("Keep answers short.", "team-orchestrator")]
  test("reads a violation line and ignores OK or noise", () => {
    expect(RuleEnforce.verdict("VIOLATION 2: the reply is a page long", entries)?.entry.text).toBe("Keep answers short.")
    expect(RuleEnforce.verdict("OK", entries)).toBeUndefined()
    expect(RuleEnforce.verdict("VIOLATION 9: nope", entries)).toBeUndefined()
    expect(RuleEnforce.verdict(undefined, entries)).toBeUndefined()
  })
})

describe("RuleEnforce built-in browser routing", () => {
  const task = /open[^\n]{0,40}https?:\/\//i
  test("a subagent or script that takes page work, or starts a browser, is refused", () => {
    expect(RuleEnforce.builtin({ tool: "subagent", agent: "x", input: { agent: "developer", prompt: "open https://example.com and click" } }, task)).toBeDefined()
    expect(RuleEnforce.builtin({ tool: "subagent", agent: "x", input: { agent: "team-browser-agent", prompt: "open https://example.com" } }, task)).toBeUndefined()
    expect(RuleEnforce.builtin({ tool: "subagent", agent: "x", input: { agent: "developer", prompt: "fix the parser" } }, task)).toBeUndefined()
    expect(RuleEnforce.builtin({ tool: "team_forge", agent: "x", input: { action: "role", name: "Browser Registration Agent" } }, task)).toBeDefined()
    expect(RuleEnforce.builtin({ tool: "sessions", agent: "x", input: { action: "create", role: "browser-registration-agent" } }, task)).toBeDefined()
    expect(RuleEnforce.builtin({ tool: "sessions", agent: "x", input: { action: "create", role: "browser-agent" } }, task)).toBeUndefined()
    expect(RuleEnforce.builtin({ tool: "subagent", agent: "x", input: { agent: "team-browser-helper", prompt: "x" } }, task)).toBeDefined()
    expect(RuleEnforce.builtin({ tool: "team_forge", agent: "x", input: { action: "team", members: [{ role: "browser-registration-agent" }] } }, task)).toBeDefined()
    expect(RuleEnforce.builtin({ tool: "execute", agent: "x", input: { code: "await tools.sessions({ action: 'create', role: 'browser-registrar' })" } }, task)).toBeDefined()
    expect(RuleEnforce.builtin({ tool: "execute", agent: "x", input: { code: "await tools.sessions({ action: 'create', role: 'browser-agent' })" } }, task)).toBeUndefined()
    expect(RuleEnforce.builtin({ tool: "sessions", agent: "x", input: { action: "create", role: "developer", title: "Browser tests" } }, task)).toBeUndefined()
    expect(RuleEnforce.builtin({ tool: "sessions", agent: "x", input: { action: "create", role: "developer", title: "Browser 3" } }, task)).toBeDefined()
    expect(RuleEnforce.builtin({ tool: "sessions", agent: "x", input: { action: "create", role: "browser-agent", title: "Browser 3" } }, task)).toBeUndefined()
    expect(RuleEnforce.builtin({ tool: "execute", agent: "x", input: { code: "import('playwright').then(p => p.chromium.launch())" } }, task)).toBeDefined()
    expect(RuleEnforce.builtin({ tool: "execute", agent: "x", input: { code: "console.log(1)" } }, task)).toBeUndefined()
  })
})
