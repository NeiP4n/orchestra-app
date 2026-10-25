export * as Federation from "./federation.js"

import { Option, Schema } from "effect"
import { ascending } from "./identifier.js"
import { ProjectID } from "./orchestra.js"
import { SessionID } from "./session-id.js"
import type { SessionMetadata } from "./session-metadata.js"
import { statics } from "./schema.js"

// A federation is a room whose members are projects. Each project keeps its own rules and
// access; projects never touch each other's sessions or files. They only exchange tickets,
// from the sending project's orchestrator to the receiving project's orchestrator.

// What a project shows to the other projects of the room.
//   hidden  — it is not listed
//   summary — name and progress of its definition of done
//   read    — also its public notes and contracts
export const Visibility = Schema.Literals(["hidden", "summary", "read"]).annotate({
  identifier: "Federation.Visibility",
})
export type Visibility = typeof Visibility.Type

// What one project may ask of another.
//   question — read-only: answered from what the receiver exposes
//   request  — asks the receiver to change something; always waits for a human on the receiving side
//   contract — publishes an agreed interface (API shape, schema) for the receiver to store as a note
export const Kind = Schema.Literals(["question", "request", "contract"]).annotate({ identifier: "Federation.Kind" })
export type Kind = typeof Kind.Type

export const Status = Schema.Literals(["pending", "accepted", "rejected", "answered", "done", "expired"]).annotate({
  identifier: "Federation.Status",
})
export type Status = typeof Status.Type

// One rule on the receiving side: a peer project and the kinds of ticket it may send.
// Only questions can be answered without a human; see `autoAnswers`.
export const Grant = Schema.Struct({
  peer: ProjectID,
  allow: Schema.Array(Kind),
  autoAnswer: Schema.Boolean.pipe(Schema.optional),
}).annotate({ identifier: "Federation.Grant" })
export interface Grant extends Schema.Schema.Type<typeof Grant> {}

// A project's side of the agreement. A peer without a grant may do nothing.
export const Policy = Schema.Struct({
  project: ProjectID,
  visibility: Visibility,
  grants: Schema.Array(Grant),
  // Tickets a peer may keep open at once, so one project cannot flood another's orchestrator.
  maxOpen: Schema.Number.pipe(Schema.optional),
}).annotate({ identifier: "Federation.Policy" })
export interface Policy extends Schema.Schema.Type<typeof Policy> {}

// A named set of projects the operator keeps together, such as "Shop" for its web, API and
// mobile projects. The first project is the group's coordinator. An optional group-bound chat
// is stored here so the UI and federation tool can identify its group and coordination mode.
export const CoordinationMode = Schema.Literals(["lead", "council"]).annotate({
  identifier: "Federation.CoordinationMode",
})
export type CoordinationMode = typeof CoordinationMode.Type

export const Group = Schema.Struct({
  name: Schema.String,
  projects: Schema.Array(ProjectID),
  // Optional for compatibility with groups saved before coordination modes existed.
  mode: CoordinationMode.pipe(Schema.optional),
  supervisor: SessionID.pipe(Schema.optional),
}).annotate({ identifier: "Federation.Group" })
export interface Group extends Schema.Schema.Type<typeof Group> {}

export function modeOf(group: Pick<Group, "mode">): CoordinationMode {
  return group.mode ?? "lead"
}

// The marker a group-bound chat carries in its session metadata. It names the group the chat
// belongs to, the coordinator project and the coordination mode, so any reader can tell a
// group's chat from a project's own session without asking the group registry.
// Primary key for the current Orchestra contract; the legacy "opencode-pp:" key is retained
// as a read fallback so sessions persisted before the rebrand still resolve their group chat.
export const GroupSupervisorMetadataKey = "orchestra:group-supervisor"
const LEGACY_GROUP_SUPERVISOR_METADATA_KEY = "opencode-pp:group-supervisor"

export const GroupSupervisorMetadata = Schema.Struct({
  groupName: Schema.String,
  leader: ProjectID,
  mode: CoordinationMode,
}).annotate({ identifier: "Federation.GroupSupervisorMetadata" })
export interface GroupSupervisorMetadata extends Schema.Schema.Type<typeof GroupSupervisorMetadata> {}

const decodeGroupSupervisor = Schema.decodeUnknownOption(GroupSupervisorMetadata)

export function groupSupervisor(metadata?: SessionMetadata) {
  if (!metadata) return undefined
  const candidates = [metadata[GroupSupervisorMetadataKey], metadata[LEGACY_GROUP_SUPERVISOR_METADATA_KEY]]
  for (const candidate of candidates) {
    const decoded = Option.getOrUndefined(decodeGroupSupervisor(candidate))
    if (decoded) return decoded
  }
  return undefined
}

// The marker of the message that sets a group chat up. It tells the Council that the message is
// context, not a task the operator gave.
export const GroupBootstrapMetadataKey = "orchestra:group-supervisor-bootstrap"

// Every unordered pair of a group's projects.
export function pairs<T>(items: ReadonlyArray<T>): ReadonlyArray<readonly [T, T]> {
  return items.flatMap((first, index) => items.slice(index + 1).map((second) => [first, second] as const))
}

// What linking two projects grants each other: they appear to each other, and may ask
// questions. Anything beyond that stays the operator's explicit choice.
export function linkPolicy(policy: Policy, peer: ProjectID): Policy {
  const grant = grantOf(policy, peer)
  return {
    ...policy,
    visibility: policy.visibility === "hidden" ? "summary" : policy.visibility,
    grants: [
      ...policy.grants.filter((item) => item.peer !== peer),
      grant ? { ...grant, allow: [...new Set([...grant.allow, "question" as const])] } : { peer, allow: ["question"] },
    ],
  }
}

// Takes back everything linking gave and everything granted since: the peer is no longer known to this project.
export function unlinkPolicy(policy: Policy, peer: ProjectID): Policy {
  return { ...policy, grants: policy.grants.filter((item) => item.peer !== peer) }
}

export const TicketID =Schema.String.check(Schema.isStartsWith("tkt_")).pipe(
  Schema.brand("FederationTicketID"),
  statics((schema) => ({ create: () => schema.make("tkt_" + ascending()) })),
)
export type TicketID = typeof TicketID.Type

export const Ticket = Schema.Struct({
  id: TicketID,
  from: ProjectID,
  to: ProjectID,
  kind: Kind,
  subject: Schema.String,
  body: Schema.String,
  status: Status,
  // Projects this ticket already passed through, oldest first. A receiver that finds itself
  // here must not forward it again, which ends A → B → A loops.
  chain: Schema.Array(ProjectID),
  answer: Schema.String.pipe(Schema.optional),
  created: Schema.Number,
  updated: Schema.Number,
}).annotate({ identifier: "Federation.Ticket" })
export interface Ticket extends Schema.Schema.Type<typeof Ticket> {}

export const defaultMaxOpen = 5
// A ticket may be forwarded this many times; longer chains are almost always a loop.
export const maxChain = 3

export const defaultPolicy = (project: ProjectID): Policy => ({ project, visibility: "hidden", grants: [] })

export function grantOf(policy: Policy, peer: ProjectID) {
  return policy.grants.find((grant) => grant.peer === peer)
}

export function allows(policy: Policy, peer: ProjectID, kind: Kind) {
  return grantOf(policy, peer)?.allow.includes(kind) ?? false
}

// Whether the receiver may answer or act without asking its human first. Only questions
// qualify, and only when the receiver granted it: a request or contract changes the
// receiving project, so a person there always decides.
export function autoAnswers(policy: Policy, peer: ProjectID, kind: Kind) {
  return kind === "question" && grantOf(policy, peer)?.autoAnswer === true && allows(policy, peer, kind)
}

export type Refusal = "no-grant" | "kind-not-allowed" | "too-many-open" | "loop" | "chain-too-long" | "self"

// The receiver's policy decides, not the sender's claim about itself: this runs on the
// receiving side before a ticket reaches its orchestrator.
export function admit(
  policy: Policy,
  ticket: Pick<Ticket, "from" | "to" | "kind" | "chain">,
  openFromPeer: number,
): Refusal | undefined {
  if (ticket.from === ticket.to) return "self"
  if (!grantOf(policy, ticket.from)) return "no-grant"
  if (!allows(policy, ticket.from, ticket.kind)) return "kind-not-allowed"
  if (ticket.chain.includes(ticket.to)) return "loop"
  if (ticket.chain.length > maxChain) return "chain-too-long"
  if (openFromPeer >= (policy.maxOpen ?? defaultMaxOpen)) return "too-many-open"
  return undefined
}

// ---- Society chat: names, addressing, cards and quick replies -------------------------------
//
// Every member Orchestrator of a Council group answers to a short call sign, so the operator
// writes into one chat and addresses a member with `@Name` instead of opening each project.

export const callsignPool = [
  "Atlas",
  "Borei",
  "Cinder",
  "Dune",
  "Ember",
  "Flint",
  "Gale",
  "Harbor",
  "Iris",
  "Juno",
  "Kestrel",
  "Lumen",
] as const

// The call sign of the member at `index`. The pool is reused with a numeric suffix, so names stay
// unique however large the group is.
export function callsign(index: number) {
  const base = callsignPool[index % callsignPool.length]
  const lap = Math.floor(index / callsignPool.length)
  return lap === 0 ? base : `${base}${lap + 1}`
}

export interface Member {
  project: ProjectID
  callsign: string
}

// A call sign comes from the project id, not from its place in the group, so reordering or
// renaming the group never renames a member. Two ids that land on the same name are told apart
// in id order, so the result depends only on which projects the group holds.
export function roster(projects: ReadonlyArray<ProjectID>): ReadonlyArray<Member> {
  const taken = new Set<number>()
  const slots = new Map<ProjectID, number>()
  for (const project of [...projects].sort()) {
    let hash = 2166136261
    for (const char of project) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0
    let slot = hash % callsignPool.length
    // A full lap means more members than names; the numeric suffix of `callsign` keeps them unique.
    while (taken.has(slot)) slot++
    taken.add(slot)
    slots.set(project, slot)
  }
  return projects.map((project) => ({ project, callsign: callsign(slots.get(project)!) }))
}

const mention = /(^|[^\p{L}\p{N}_@])@([\p{L}\p{N}_-]+)/gu
const everyone = new Set(["all", "everyone", "все", "всем"])

// Who a message is addressed to. `@all` or no mention at all means every member; unknown
// names are returned so the chat can tell the operator instead of silently ignoring them.
export function addressees(text: string, members: ReadonlyArray<Member>) {
  const named: Member[] = []
  const unknown: string[] = []
  let all = false
  for (const match of text.matchAll(mention)) {
    const word = match[2]!.toLowerCase()
    if (everyone.has(word)) {
      all = true
      continue
    }
    const found = members.find((member) => member.callsign.toLowerCase() === word)
    if (!found) unknown.push(match[2]!)
    else if (!named.includes(found)) named.push(found)
  }
  return { targets: all || named.length === 0 ? members : named, direct: !all && named.length > 0, unknown }
}

export interface CouncilProposal {
  name: string
  callsign?: string
  answer: string
}

export interface CouncilResults {
  id: string
  group: string
  subject?: string
  proposals: ReadonlyArray<CouncilProposal>
}

const attribute = (source: string, key: string) => new RegExp(`${key}="([^"]*)"`).exec(source)?.[1]
const unquote = (text: string) => text.replaceAll("&lt;", "<").replaceAll("&gt;", ">")

// Reads the combined report the Council receives once every invited Orchestrator has answered,
// so a client can draw it as one card per member instead of raw markup.
export function parseCouncilResults(text: string): CouncilResults | undefined {
  const head = /^\s*<group-council-results\b([^>]*)>/.exec(text)
  if (!head) return undefined
  const id = attribute(head[1]!, "id")
  const group = attribute(head[1]!, "group")
  if (!id || group === undefined) return undefined
  const proposals = [...text.matchAll(/<proposal\b([^>]*)>\n?([\s\S]*?)\n?<\/proposal>/g)].map((match) => ({
    name: unquote(attribute(match[1]!, "project") ?? ""),
    callsign: attribute(match[1]!, "callsign"),
    answer: unquote(match[2]!),
  }))
  const subject = /^Original subject: (.*)$/m.exec(text)?.[1]
  return { id, group: unquote(group), subject: subject ? unquote(subject) : undefined, proposals }
}

export interface ReplyOption {
  label: string
  // What is sent to the chat when the operator picks the option; the label when omitted.
  send: string
}

const optionsBlock = /<reply-options>\n?([\s\S]*?)\n?<\/reply-options>/

// A chat message may end with a `<reply-options>` block, one `- Label | text to send` per line.
// The block is lifted out of the prose so a client can draw it as buttons.
export function parseReplyOptions(text: string): { body: string; options: ReadonlyArray<ReplyOption> } {
  const found = optionsBlock.exec(text)
  if (!found) return { body: text, options: [] }
  const options = found[1]!
    .split("\n")
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim())
    .filter(Boolean)
    .slice(0, 6)
    .map((line) => {
      const [label, ...rest] = line.split("|")
      const send = rest.join("|").trim()
      return { label: label!.trim(), send: send || label!.trim() }
    })
    .filter((option) => option.label)
  return { body: text.replace(optionsBlock, "").trimEnd(), options }
}

// A member Orchestrator may mark where a question is addressed to the operator or another member.
export const replyOptionsHint =
  "When you ask the operator to choose, finish the message with <reply-options> holding 2-5 lines of the form `- Short label | full text sent when picked` (the text after | is optional). The chat shows them as buttons."
