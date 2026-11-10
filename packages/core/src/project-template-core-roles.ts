export * as ProjectTemplateCoreRoles from "./project-template-core-roles.js"

import { createHash } from "node:crypto"
import { PROMPT_ORCHESTRATOR, ORCHESTRATOR_MANDATES } from "./plugin/agent.js"
import type { Orchestra } from "@orchestra/schema/orchestra"
import type { ProjectTemplateV2 as V2 } from "./project-template-v2.js"

export function portable(role: Orchestra.Role): V2.Role {
  return {
    agent: role.agent,
    name: role.name,
    description: role.description,
    rules: role.rules,
    category: role.category,
    readOnly: role.readOnly,
    ...(role.mode === undefined ? {} : { mode: role.mode }),
    ...(role.model === undefined ? {} : { model: role.model }),
    ...(role.models === undefined ? {} : { models: [...role.models] }),
    ...(role.variant === undefined ? {} : { variant: role.variant }),
    ...(role.tools === undefined ? {} : { tools: [...role.tools] }),
    ...(role.autoTools === undefined ? {} : { autoTools: role.autoTools }),
    ...(role.hub === undefined ? {} : { hub: [...role.hub] }),
    ...(role.registry === undefined ? {} : { registry: [...role.registry] }),
  }
}
/** Reserved runtime identity is compatibility evidence, never an importable replacement for built-in mandates. */
export function current(roles: readonly Orchestra.Role[]): V2.Role[] {
  const hash = createHash("sha256").update(PROMPT_ORCHESTRATOR).update("\n").update(ORCHESTRATOR_MANDATES).digest("hex")
  const browser = roles.filter((role) => role.agent === "team-browser-agent")
  if (browser.length > 1) throw Error("Canonical BrowserAgent definition is ambiguous")
  return [
    {
      agent: "orchestrator",
      name: "Orchestrator",
      description: "Built-in project coordinator",
      rules: "Built-in runtime fingerprint sha256:" + hash,
      category: "Planning",
      readOnly: false,
    },
    ...browser.map(portable),
  ]
}
