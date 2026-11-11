export * as RoleTemplateGenerator from "./generator.js"

import { Orchestra } from "@orchestra/schema/orchestra"
import { RoleToolkits } from "./toolkits.js"

// Builds a team template from a short task description, out of the roles and template shape the
// repo already has. It is deterministic and costs no model call: words in the task select roles by
// id, every pick is checked against `Orchestra.roles`, and the playbook tells the orchestrator to
// draw on those roles only when the work needs them. Nothing here opens a session or widens a
// toolkit: each role keeps its own tool list (or its kind's, see RoleToolkits).

const MAX_ROLES = 6

// Task words -> role ids, in priority order. Ids that are not shipped roles are dropped by `pick`.
const SIGNALS: ReadonlyArray<{ readonly pattern: RegExp; readonly roles: ReadonlyArray<string> }> = [
  {
    pattern: /\b(security|vulnerab|exploit|auth(?:entication|orization)?|secret|cve|pentest)/i,
    roles: ["security-auditor"],
  },
  {
    pattern: /\b(ui|ux|frontend|front-end|react|css|web ?page|landing|tui|interface|screen)/i,
    roles: ["frontend-developer", "designer"],
  },
  {
    pattern: /\b(backend|back-end|api|server|endpoint|rest|graphql)/i,
    roles: ["backend-developer", "api-contract-engineer"],
  },
  {
    pattern: /\b(database|sql|schema|migration|postgres|sqlite)/i,
    roles: ["database-engineer", "data-migration-engineer"],
  },
  { pattern: /\b(android|ios|mobile|apk)/i, roles: ["mobile-developer"] },
  { pattern: /\b(desktop|electron|windows app|installer)/i, roles: ["desktop-developer"] },
  { pattern: /\b(deploy|release|ci\b|pipeline|docker|infra|devops)/i, roles: ["devops"] },
  { pattern: /\b(perf|performance|slow|latency|memory leak|token|cost)/i, roles: ["performance-engineer"] },
  { pattern: /\b(research|compare|investigate|survey|find out|evaluate)/i, roles: ["researcher"] },
  { pattern: /\b(docs?|documentation|readme|article|copy|write-?up)/i, roles: ["writer"] },
  { pattern: /\b(bug|crash|broken|fails?|regression|error)/i, roles: ["debugger"] },
  { pattern: /\b(test|qa|verify|coverage)/i, roles: ["tester"] },
  { pattern: /\b(review|audit)/i, roles: ["reviewer"] },
  { pattern: /\b(design|architecture|plan|refactor|restructure)/i, roles: ["architect"] },
  { pattern: /\b(dependenc|upgrade|package|library)/i, roles: ["dependency-auditor"] },
  { pattern: /\b(cross-?platform|windows|linux|macos)/i, roles: ["compatibility-engineer"] },
]

// Present on every generated team when the task does not already imply them: someone builds, someone checks.
const BASE = ["developer", "reviewer"]

export interface Generated extends Orchestra.TemplateSpec {
  /** Per recommended role: the tools it would carry, so the saving over "everything" is visible. */
  readonly toolkits: ReadonlyArray<{
    readonly role: string
    readonly kind: RoleToolkits.RoleKind
    readonly tools: ReadonlyArray<string>
  }>
}

const known = () => new Map(Orchestra.roles.map((role) => [role.id, role] as const))

/** The role ids a task description calls for: signals first, then the base builder and checker; at most six. */
export function pick(task: string): ReadonlyArray<string> {
  const catalog = known()
  const chosen: string[] = []
  const add = (id: string) => {
    if (catalog.has(id) && !chosen.includes(id)) chosen.push(id)
  }
  for (const signal of SIGNALS) if (signal.pattern.test(task)) signal.roles.forEach(add)
  BASE.forEach(add)
  return chosen.slice(0, MAX_ROLES)
}

/** A template for this task: recommended roles, a playbook for the orchestrator, and each role's toolkit. */
export function generate(task: string, name?: string): Generated {
  const text = task.trim()
  if (text === "") throw new Error("A task description is needed to generate a template.")
  const catalog = known()
  const ids = pick(text)
  const title = (name?.trim() || text.split(/[.\n]/, 1)[0] || "Team").slice(0, 60)
  const members = ids.map((id) => ({
    agent: Orchestra.role(id),
    title: catalog.get(id)!.name,
    category: catalog.get(id)!.category,
  }))
  return {
    name: title,
    description: `Team for: ${text.slice(0, 200)}`,
    members,
    roles: ids,
    playbook: [
      `Task: ${text.slice(0, 400)}`,
      `Recommended roles: ${ids.join(", ")}. Create a worker only when a step needs that role, and reuse an existing session of the role.`,
      "Inspect first, then plan stages with acceptance criteria. Hand each worker one clear task and read its final report, not its transcript.",
      "Done means every acceptance criterion has evidence (a command run, its real output). Read-only roles never edit files.",
    ].join("\n"),
    toolkits: ids.map((id) => {
      const role = catalog.get(id)!
      return { role: id, kind: RoleToolkits.kindOfRole(role), tools: RoleToolkits.effectiveTools(role) ?? [] }
    }),
  }
}
