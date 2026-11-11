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


describe("rule load action gate", () => {
  test("failed refresh blocks actions for ordinary and scheduled sessions, not rules reads", () => {
    for (const id of ["rules-gate-interactive", "rules-gate-scheduled"]) {
      RuleEnforce.remember(id, [rule("deny tool shell")])
      RuleEnforce.loading(id)
      expect(RuleEnforce.recall(id)).toEqual([])
      for (const tool of ["shell", "browser", "execute", "triggers", "write", "webfetch"])
        expect(RuleEnforce.unavailableRefusal(id, tool, {})).toContain("No actions are allowed")
      for (const action of ["list", "violations"])
        expect(RuleEnforce.unavailableRefusal(id, "rules", { action })).toBeUndefined()
      for (const action of ["add", "remove", undefined])
        expect(RuleEnforce.unavailableRefusal(id, "rules", { action })).toBeDefined()
      expect(RuleEnforce.unavailableRefusal(id, "question", {})).toBeUndefined()
      RuleEnforce.remember(id, [rule("deny tool browser")])
      expect(RuleEnforce.unavailableRefusal(id, "shell", {})).toBeUndefined()
      expect(RuleEnforce.violation(RuleEnforce.recall(id), { tool: "browser", agent: "a", input: {} })).toBeDefined()
    }
  })
})


describe("resource-level rule enforcement", () => {
  test("Russian explicit directives have the same hard semantics", () => {
    expect(RuleEnforce.violation([rule("Запретить инструмент shell")], { tool: "shell", agent: "a", input: {} })).toBeDefined()
    expect(RuleEnforce.violation([rule("Только роль browser-agent может использовать инструмент browser")], { tool: "browser", agent: "team-developer", input: {} })).toBeDefined()
    expect(RuleEnforce.violation([rule("Запретить команду git push для роли developer")], { tool: "shell", agent: "team-developer", input: { command: "git push" } })).toBeDefined()
    expect(RuleEnforce.parse("Не делай ничего плохого")).toBeUndefined()
  })
  test("root glob, traversal, Windows separators and resolved patch paths cannot dodge deny path", () => {
    for (const file of [".env", "./.env", "safe/../.env", "C:\\work\\.env", "/work/sub/../.env"]) {
      expect(RuleEnforce.permissionViolation([rule("deny path **/.env")], { action: "edit", agent: "a", resources: [file] })).toBeDefined()
    }
    expect(RuleEnforce.permissionViolation([rule("deny path **/.env")], { action: "read", agent: "a", resources: ["src/main.ts"] })).toBeUndefined()
  })
  test("a check or nested tool cannot hide its command from the final permission guard", () => {
    expect(RuleEnforce.permissionViolation([rule("deny command git push")], { action: "shell", agent: "a", resources: ["git push origin dev"] })).toBeDefined()
    expect(RuleEnforce.permissionViolation([rule("deny command git push")], { action: "shell", agent: "a", resources: ["git status"] })).toBeUndefined()
  })
  test("opaque execution is refused while a path boundary cannot be enforced inside it", () => {
    for (const action of ["shell", "execute", "console", "terminal", "subagent"]) {
      expect(RuleEnforce.permissionViolation([rule("deny path **/.env")], { action, agent: "a", resources: ["python script.py"] })).toBeDefined()
    }
    expect(RuleEnforce.permissionViolation([rule("deny path **/.env for role developer")], { action: "shell", agent: "team-tester", resources: ["bun test"] })).toBeUndefined()
  })
})

 test("only-role remains final for a different caller, and opaque console cannot bypass command rules", () => {
   const only = [{ title: "Project", text: "only role lead may use tool edit", by: "operator" }]
   expect(RuleEnforce.permissionViolation(only, { action: "edit", agent: "worker", resources: ["a"] })).toBe(only[0])
   expect(RuleEnforce.permissionViolation(only, { action: "edit", agent: "lead", resources: ["a"] })).toBeUndefined()
   const command = [{ title: "Project", text: "deny command git push", by: "operator" }]
   expect(RuleEnforce.violation(command, { tool: "console", agent: "lead", input: { action: "write", text: "git push\n" } })).toBe(command[0])
 })
