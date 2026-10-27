import { describe, expect, it } from "bun:test";
import { templates, roles } from "@orchestra/schema/orchestra";
import { PROMPT_ORCHESTRATOR } from "@orchestra/core/plugin/agent";
import { TEAM } from "@orchestra/core/plugin/team";

describe("Orchestra Software Factory & Anti-Theater Verification", () => {
  it("verifies the factory template contains all 6 required roles", () => {
    const factoryTmpl = templates.find((t) => t.id === "factory");
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

  it("verifies PROMPT_ORCHESTRATOR enforces Software Factory and Anti-Simulation rules", () => {
    expect(PROMPT_ORCHESTRATOR).toContain("Software Factory Protocol");
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
