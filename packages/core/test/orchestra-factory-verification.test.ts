import { describe, expect, it } from "bun:test";
import { legacyTemplates, templates, roles } from "@orchestra/schema/orchestra";
import { PROMPT_ORCHESTRATOR } from "@orchestra/core/plugin/agent";
import { TEAM } from "@orchestra/core/plugin/team";

describe("Orchestra dynamic orchestration & Anti-Theater Verification", () => {
  it("factory is retired from the built-in selection but preserved as a legacy record", () => {
    // Removed built-ins no longer appear in the normal template list.
    for (const id of ["full", "factory", "pro-engineers", "proof-driven"]) {
      expect(templates.find((t) => t.id === id)).toBeUndefined();
    }
    // The legacy record keeps the factory's roster and playbook, so projects
    // created from it keep working with the playbook they were created with.
    const factoryTmpl = legacyTemplates.find((t) => t.id === "factory");
    expect(factoryTmpl).toBeDefined();
    expect(factoryTmpl?.name).toBe("Software Factory");
    expect(factoryTmpl?.members.length).toBe(6);

    const memberAgents = factoryTmpl?.members.map((m) => m.agent);
    expect(memberAgents).toContain("team-deep-researcher" as any);
    expect(memberAgents).toContain("team-architect" as any);
    expect(memberAgents).toContain("team-developer" as any);
    expect(memberAgents).toContain("team-tester" as any);
    expect(memberAgents).toContain("team-reviewer" as any);
  });

  it("verifies PROMPT_ORCHESTRATOR enforces dynamic orchestration and Anti-Simulation rules", () => {
    expect(PROMPT_ORCHESTRATOR).toContain("Autonomous Dynamic Workflow");
    expect(PROMPT_ORCHESTRATOR).toContain("Dynamic team sizing");
    expect(PROMPT_ORCHESTRATOR).not.toContain("Multi-Agent Software Factory by Default");
    expect(PROMPT_ORCHESTRATOR).not.toContain("5-stage DoD");
    expect(PROMPT_ORCHESTRATOR).toContain("Research-First Mandate");
    expect(PROMPT_ORCHESTRATOR).toContain("STRICT BAN ON SIMULATION FALLBACKS");
    expect(PROMPT_ORCHESTRATOR).toContain("STRICT BAN ON FRAUDULENT TESTS");
    expect(PROMPT_ORCHESTRATOR).toContain("CRITICAL DOD VERIFICATION INVARIANT");
  });

  it("verifies TEAM prompt strictly prohibits simulation fallbacks and fake tests", () => {
    expect(TEAM).toContain("STRICT PROHIBITION OF SIMULATION FALLBACKS");
    expect(TEAM).toContain("STRICT PROHIBITION OF FRAUDULENT TESTS");
    expect(TEAM).toContain("RESEARCH & REUSE FIRST");
  });

  it("verifies role rules in Schema contain anti-theater invariants", () => {
    const arch = roles.find((r) => r.id === "architect");
    const dev = roles.find((r) => r.id === "developer");
    const mob = roles.find((r) => r.id === "mobile-developer");
    const tst = roles.find((r) => r.id === "tester");
    const rev = roles.find((r) => r.id === "reviewer");

    expect(arch?.rules).toContain("Strictly forbid trivial file-existence verification commands");
    expect(dev?.rules).toContain("Never implement simulation fallbacks");
    expect(mob?.rules).toContain("Strict ban on simulation fallbacks");
    expect(tst?.rules).toContain("Strict ban on fraudulent tests");
    expect(rev?.rules).toContain("Specifically check for simulation shortcuts");
  });
});
