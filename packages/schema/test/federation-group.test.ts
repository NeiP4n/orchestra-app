import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Group } from "../src/group.js"
import { ProjectID } from "../src/orchestra.js"
import { SessionID } from "../src/session-id.js"

describe("Federation Group schema and validation", () => {
  const p1 = ProjectID.make("prj_01member1")
  const p2 = ProjectID.make("prj_02member2")

  test("decodes and encodes council (Общество) mode configuration", () => {
    const raw = {
      id: "grp_council_1",
      name: "OpenCode Self-Improvement",
      mode: "council" as const,
      topology: "mesh" as const,
      members: [
        {
          projectID: p1,
          name: "SI Research",
          role: "coordinator" as const,
          permissions: ["read", "write", "ticket", "steer", "vote"] as const,
          canVote: true,
          canSteer: true,
        },
        {
          projectID: p2,
          name: "SI Design",
          role: "member" as const,
          permissions: ["read", "write", "vote"] as const,
          canVote: true,
        },
      ],
      description: "Self-improvement federation council",
    }

    const decoded = Schema.decodeUnknownSync(Group.FederationGroupConfig)(raw)
    expect(decoded.name).toBe("OpenCode Self-Improvement")
    expect(decoded.mode).toBe("council")
    expect(decoded.topology).toBe("mesh")
    expect(decoded.members.length).toBe(2)
    expect(decoded.members[0].canVote).toBe(true)
    expect(Group.titleForMode(decoded.mode)).toBe("Общество")

    const encoded = Schema.encodeSync(Group.FederationGroupConfig)(decoded)
    expect(encoded).toEqual(raw)

    const validation = Group.validateFederationGroup(decoded)
    expect(validation.valid).toBe(true)
    expect(validation.errors.length).toBe(0)
  })

  test("decodes and encodes lead (Президент) mode with hierarchical topology", () => {
    const supSession = SessionID.make("ses_supervisor1")
    const raw = {
      id: "grp_lead_1",
      name: "OpenCodePP Lead Fleet",
      mode: "lead" as const,
      topology: "hierarchical" as const,
      supervisorSessionID: supSession,
      members: [
        {
          projectID: p1,
          name: "Creator",
          role: "lead" as const,
          permissions: ["admin", "read", "write", "steer"] as const,
          canSteer: true,
        },
        {
          projectID: p2,
          name: "Core Implementer",
          role: "member" as const,
          permissions: ["read", "write"] as const,
          upstream: p1,
        },
      ],
    }

    const decoded = Schema.decodeUnknownSync(Group.FederationGroupConfig)(raw)
    expect(decoded.mode).toBe("lead")
    expect(decoded.topology).toBe("hierarchical")
    expect(decoded.supervisorSessionID).toBe(supSession)
    expect(Group.titleForMode(decoded.mode)).toBe("Президент")

    const encoded = Schema.encodeSync(Group.FederationGroupConfig)(decoded)
    expect(encoded).toEqual(raw)

    const validation = Group.validateFederationGroup(decoded)
    expect(validation.valid).toBe(true)
    expect(validation.errors.length).toBe(0)
  })

  test("validates duplicate project IDs and missing names", () => {
    const invalidConfig: Group.FederationGroupConfig = {
      id: "grp_invalid",
      name: "   ",
      mode: "council",
      topology: "mesh",
      members: [
        {
          projectID: p1,
          name: "Member A",
          role: "member",
          permissions: ["read"],
        },
        {
          projectID: p1,
          name: "Member A duplicate",
          role: "member",
          permissions: ["read"],
        },
      ],
    }

    const validation = Group.validateFederationGroup(invalidConfig)
    expect(validation.valid).toBe(false)
    expect(validation.errors.some((e) => e.includes("Group name must not be empty"))).toBe(true)
    expect(validation.errors.some((e) => e.includes("Duplicate member projectID"))).toBe(true)
  })

  test("validates invalid upstream hierarchy and self-reference", () => {
    const pUnknown = ProjectID.make("prj_unknown")
    const invalidTopology: Group.FederationGroupConfig = {
      id: "grp_topo_err",
      name: "Hierarchy Error",
      mode: "lead",
      topology: "star",
      members: [
        {
          projectID: p1,
          name: "Lead Member",
          role: "lead",
          permissions: ["admin"],
          upstream: p1, // self reference
        },
        {
          projectID: p2,
          name: "Child Member",
          role: "member",
          permissions: ["read"],
          upstream: pUnknown, // missing upstream
        },
      ],
    }

    const validation = Group.validateFederationGroup(invalidTopology)
    expect(validation.valid).toBe(false)
    expect(validation.errors.some((e) => e.includes("cannot have itself as upstream"))).toBe(true)
    expect(validation.errors.some((e) => e.includes("references non-existent upstream"))).toBe(true)
  })

  test("validates lead mode requires a leader and council requires voters", () => {
    const leadWithoutLeader: Group.FederationGroupConfig = {
      id: "grp_no_lead",
      name: "No Leader Group",
      mode: "lead",
      topology: "mesh",
      members: [
        {
          projectID: p1,
          name: "Worker 1",
          role: "member",
          permissions: ["read"],
        },
      ],
    }
    const leadVal = Group.validateFederationGroup(leadWithoutLeader)
    expect(leadVal.valid).toBe(false)
    expect(leadVal.errors.some((e) => e.includes("Lead mode requires at least one member with 'lead'"))).toBe(true)

    const councilNoVoters: Group.FederationGroupConfig = {
      id: "grp_no_voters",
      name: "Observer Council",
      mode: "council",
      topology: "mesh",
      members: [
        {
          projectID: p1,
          name: "Observer 1",
          role: "observer",
          permissions: ["read"],
          canVote: false,
        },
      ],
    }
    const councilVal = Group.validateFederationGroup(councilNoVoters)
    expect(councilVal.valid).toBe(false)
    expect(councilVal.errors.some((e) => e.includes("Council mode requires at least one voting member"))).toBe(true)
  })

  test("evaluates member permissions correctly", () => {
    const adminMember: Group.FederationMemberConfig = {
      projectID: p1,
      name: "Admin",
      role: "lead",
      permissions: ["admin"],
    }
    expect(Group.hasPermission(adminMember, "read")).toBe(true)
    expect(Group.hasPermission(adminMember, "write")).toBe(true)
    expect(Group.hasPermission(adminMember, "steer")).toBe(true)

    const regularMember: Group.FederationMemberConfig = {
      projectID: p2,
      name: "Regular",
      role: "member",
      permissions: ["read", "ticket"],
    }
    expect(Group.hasPermission(regularMember, "read")).toBe(true)
    expect(Group.hasPermission(regularMember, "ticket")).toBe(true)
    expect(Group.hasPermission(regularMember, "write")).toBe(false)
    expect(Group.hasPermission(regularMember, "steer")).toBe(false)
  })
})
