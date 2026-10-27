export * as Group from "./group.js"

import { Schema } from "effect"
import { optional, PositiveInt } from "./schema.js"
import { ProjectID } from "./orchestra.js"
import { SessionID } from "./session-id.js"

export const CoordinationMode = Schema.Literals(["council", "lead"]).annotate({
  identifier: "Group.CoordinationMode",
  description: "Coordination mode: 'council' (Общество) for peer consensus, 'lead' (Президент) for hierarchical orchestration.",
})
export type CoordinationMode = typeof CoordinationMode.Type

export function titleForMode(mode: CoordinationMode): string {
  return mode === "council" ? "Общество" : "Президент"
}

export const TopologyType = Schema.Literals(["mesh", "star", "hierarchical", "ring"]).annotate({
  identifier: "Group.TopologyType",
  description: "Network topology of federated members.",
})
export type TopologyType = typeof TopologyType.Type

export const MemberRole = Schema.Literals([
  "coordinator",
  "lead",
  "member",
  "observer",
  "advisor",
]).annotate({
  identifier: "Group.MemberRole",
  description: "Role of a project member in the federation group.",
})
export type MemberRole = typeof MemberRole.Type

export const AccessPermission = Schema.Literals([
  "read",
  "write",
  "admin",
  "ticket",
  "steer",
  "vote",
]).annotate({
  identifier: "Group.AccessPermission",
  description: "Access permission granted to a federation member.",
})
export type AccessPermission = typeof AccessPermission.Type

export interface FederationMemberConfig extends Schema.Schema.Type<typeof FederationMemberConfig> {}
export const FederationMemberConfig = Schema.Struct({
  projectID: ProjectID,
  name: Schema.String,
  role: MemberRole,
  permissions: Schema.Array(AccessPermission),
  upstream: optional(ProjectID).annotate({
    description: "Upstream coordinator or leader in hierarchical/star topology.",
  }),
  canSteer: optional(Schema.Boolean).annotate({
    description: "Whether this member can steer execution across federated sessions.",
  }),
  canVote: optional(Schema.Boolean).annotate({
    description: "Whether this member has voting rights in council mode.",
  }),
}).annotate({ identifier: "Group.FederationMemberConfig" })

export interface FederationGroupConfig extends Schema.Schema.Type<typeof FederationGroupConfig> {}
export const FederationGroupConfig = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  mode: CoordinationMode,
  topology: TopologyType,
  members: Schema.Array(FederationMemberConfig),
  supervisorSessionID: optional(SessionID).annotate({
    description: "Associated group-bound supervisor chat session.",
  }),
  description: optional(Schema.String),
  maxConcurrentTasks: optional(PositiveInt),
}).annotate({ identifier: "Group.FederationGroupConfig" })

export class InvalidFederationGroupError extends Schema.TaggedError<InvalidFederationGroupError>()(
  "Group.InvalidFederationGroupError",
  {
    message: Schema.String,
    reason: Schema.String,
    field: optional(Schema.String),
  },
) {}

export interface ValidationResult {
  readonly valid: boolean
  readonly errors: ReadonlyArray<string>
}

export function validateFederationGroup(config: FederationGroupConfig): ValidationResult {
  const errors: string[] = []

  if (!config.name || config.name.trim().length === 0) {
    errors.push("Group name must not be empty")
  }

  if (!config.members || config.members.length === 0) {
    errors.push("Federation group must have at least one member")
  }

  const memberIds = new Set<string>()
  for (const member of config.members ?? []) {
    if (memberIds.has(member.projectID)) {
      errors.push(`Duplicate member projectID: ${member.projectID}`)
    }
    memberIds.add(member.projectID)
  }

  // Topology validation
  if (config.topology === "hierarchical" || config.topology === "star") {
    for (const member of config.members ?? []) {
      if (member.upstream && !memberIds.has(member.upstream)) {
        errors.push(`Member ${member.projectID} references non-existent upstream projectID: ${member.upstream}`)
      }
      if (member.upstream && member.upstream === member.projectID) {
        errors.push(`Member ${member.projectID} cannot have itself as upstream`)
      }
    }
  }

  // Mode validation
  if (config.mode === "lead") {
    const leads = (config.members ?? []).filter((m) => m.role === "lead" || m.role === "coordinator")
    if (leads.length === 0) {
      errors.push("Lead mode requires at least one member with 'lead' or 'coordinator' role")
    }
  } else if (config.mode === "council") {
    const votingMembers = (config.members ?? []).filter((m) => m.canVote !== false && m.role !== "observer")
    if (votingMembers.length === 0) {
      errors.push("Council mode requires at least one voting member")
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  }
}

export function hasPermission(
  member: FederationMemberConfig,
  required: AccessPermission,
): boolean {
  if (member.permissions.includes("admin")) return true
  return member.permissions.includes(required)
}
