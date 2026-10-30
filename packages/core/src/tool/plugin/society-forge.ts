export * as SocietyForgeTool from "./society-forge.js"

import { ToolFailure } from "@orchestra/ai"
import type { Context } from "@orchestra/plugin/effect/plugin"
import { Federation as FederationSchema } from "@orchestra/schema/federation"
import { Effect, Option, Result, Schema } from "effect"
import { Federation } from "../../federation.js"
import { Orchestra } from "../../orchestra.js"
import { Session } from "../../session.js"

export const name = "society_forge"

const MAX_PROJECTS = 8

const Project = Schema.Struct({
  name: Schema.String.annotate({ description: "Short project name; it also names the project's folder." }),
  brief: Schema.String.annotate({
    description:
      "The project's assignment: what it must build, its boundaries, and what it needs from or owes to the other projects. Concrete and self-contained: the project's Orchestrator sees only this and the goal.",
  }),
  team: Schema.optionalKey(Schema.String).annotate({
    description: "Exact AI team template ID from list. Mutually exclusive with role.",
  }),
  role: Schema.optionalKey(Schema.String).annotate({
    description: "Exact AI role ID from list; one worker session next to the Orchestrator. Mutually exclusive with team.",
  }),
})

export const Input = Schema.Struct({
  action: Schema.Literals(["found", "status", "list", "generate"]),
  goal: Schema.optionalKey(Schema.String).annotate({
    description:
      "For found and generate: the operator's goal in their own words. Every project's Orchestrator receives it.",
  }),
  name: Schema.optionalKey(Schema.String).annotate({
    description: "For found: the Society's name. Omit it and the Society is named after the goal.",
  }),
  directory: Schema.optionalKey(Schema.String).annotate({
    description: "For found: a full path to create the Society's folder in. Omit it for the default folder.",
  }),
  projects: Schema.optionalKey(Schema.Array(Project)).annotate({
    description: `For generate: ADDITIONAL projects the goal needs beyond the base four, 0 to ${MAX_PROJECTS}. Never list the base projects (${Federation.baseProjects.map((item) => item.name).join(", ")}): they are always created.`,
  }),
})
export const Output = Schema.Struct({ output: Schema.String })

const guide = [
  "society_forge founds a Society and builds its projects from the operator's goal.",
  "From any other chat, when the operator asks for a Society, call action=found with their goal at once. Do not ask for a name, a folder or the projects, and never assemble a Society by hand with the federation group actions. found creates the Society, its folder, its planner project and its chat, and hands the goal to that chat, which plans the projects itself.",
  "list and generate work only inside the Society's own chat. There:",
  "Call action=list first for exact team-template and role IDs. When no template fits a project, create the missing role or team with team_forge first, then use its ID.",
  `generate always creates the base projects: ${Federation.baseProjects.map((item) => item.name).join(", ")}. They are separate projects, not sessions of one project, and you do not list them.`,
  `Then call action=generate once with the goal and only the ADDITIONAL projects it needs (0 to ${MAX_PROJECTS}): research, design, marketing, security and so on. Decide yourself: do not ask the operator for names, folders or teams the goal already implies.`,
  "Each project gets its own folder inside the Society's folder, a main Orchestrator, the sessions of its team or role, links to every other project of the Society, and its brief delivered right away.",
].join("\n")

export const Plugin = {
  id: "orchestra.tool.society-forge",
  effect: Effect.fn("SocietyForgeTool.Plugin")(function* (ctx: Context) {
    const orchestra = yield* Orchestra.Service
    const federation = yield* Federation.Service
    const sessions = yield* Session.Service

    yield* ctx.tool
      .transform((editor) =>
        editor.add({
          name,
          options: { codemode: false, guide, triggers: ["societ|общест", "goal|цель"] },
          description: [
            "Found a Society from a goal, or generate its projects. found works from any chat and creates the Society with its chat, which plans the rest; status, list and generate work only inside a Society (council group) chat. status reads every project's DoD progress and whether it is working, at no model cost. Actions: found, status, list, generate.",
            "generate always creates the base projects (planner, architects, coders, testers) plus the additional ones you pass, each in the Society's folder with its Orchestrator and team, links them to each other and delivers every brief.",
          ].join("\n"),
          input: Input,
          output: Output,
          execute: (input, context) =>
            Effect.gen(function* () {
              if (input.action === "found") {
                const goal = input.goal?.trim()
                if (!goal) return yield* new ToolFailure({ message: "found needs goal: the operator's goal in their own words." })
                if (Option.isSome(yield* societyOf(context.sessionID).pipe(Effect.option)))
                  return yield* new ToolFailure({
                    message: "This chat already is a Society. Use list, then generate, to add its projects.",
                  })
                const society = yield* federation.createSociety({
                  goal,
                  ...(input.name?.trim() ? { name: input.name.trim() } : {}),
                  ...(input.directory?.trim() ? { directory: input.directory.trim() } : {}),
                })
                // The Society's chat is a session of its own: it runs on the model of the chat that founded it,
                // not on whatever the server would pick for a session without one.
                const founder = yield* sessions.get(context.sessionID).pipe(Effect.option)
                const model = Option.isSome(founder) ? founder.value.model : undefined
                if (model) yield* sessions.switchModel({ sessionID: society.sessionID, model }).pipe(Effect.ignore)
                yield* sessions.prompt({ sessionID: society.sessionID, text: goal })
                return [
                  `Society "${society.name}" founded in ${society.directory}.`,
                  `Its chat (${society.sessionID}) has the goal and is deciding the projects now; the planner project already exists.`,
                  "Tell the operator the Society is working and where its folder is. Do not create projects yourself.",
                ].join("\n")
              }

              const group = yield* societyOf(context.sessionID)

              // Progress is read from the projects' own DoD boards and sessions by the system, not asked of
              // their Orchestrators: it costs no model turn anywhere.
              if (input.action === "status") {
                const report = yield* federation.societyStatus(group.name)
                const rows = report.projects.map(
                  (item) =>
                    `- ${item.name}: DoD ${item.done}/${item.total}${item.blocked ? `, ${item.blocked} blocked` : ""} · ${item.running ? "working" : "idle"}`,
                )
                const done = report.projects.reduce((sum, item) => sum + item.done, 0)
                const total = report.projects.reduce((sum, item) => sum + item.total, 0)
                return [
                  `Society "${group.name}" · ${report.held ? "AIs HELD by the operator: nothing runs until released" : "running"} · DoD ${done}/${total}`,
                  ...rows,
                ].join("\n")
              }

              const templates = yield* orchestra.templates()
              const roles = yield* orchestra.roles()

              if (input.action === "list") {
                const projects = yield* orchestra.projects()
                return [
                  `Society "${group.name}" · folder ${yield* federation.societyRoot(group.name)}`,
                  "Projects:",
                  ...group.projects.map((id) => {
                    const project = projects.find((item) => item.id === id)
                    return `- ${project?.name ?? id} (${id})`
                  }),
                  "",
                  "AI team templates (use the exact ID as team):",
                  ...(templates.length
                    ? templates.map(
                        (template) =>
                          `- ${template.id}: ${short(template.description)}; roles: ${template.members.map((member) => roles.find((role) => role.agent === member.agent)?.id ?? member.agent).join(", ") || "none"}`,
                      )
                    : ["(none)"]),
                  "",
                  "Individual AI roles (use the exact ID as role):",
                  ...roles.map((role) => `- ${role.id}: ${short(role.description)}`),
                ].join("\n")
              }

              const goal = input.goal?.trim()
              if (!goal) return yield* new ToolFailure({ message: "generate needs goal: the operator's goal." })
              const wanted = input.projects ?? []
              if (wanted.length > MAX_PROJECTS)
                return yield* new ToolFailure({ message: `generate takes at most ${MAX_PROJECTS} additional projects.` })
              const existing = yield* orchestra.projects()
              const known = new Map(
                group.projects.flatMap((id) => existing.filter((item) => item.id === id).map((item) => [id, item] as const)),
              )
              const baseNames = new Set(Federation.baseProjects.map((item) => item.name.toLowerCase()))

              // Everything is checked before anything is created, so a typo in the last project's team
              // does not leave the first ones behind.
              const names = new Set<string>()
              const specs: Array<{ name: string; brief: string; team?: string; role?: Orchestra.Role }> = []
              for (const [index, item] of wanted.entries()) {
                const label = `Project ${index + 1}`
                const projectName = item.name.trim()
                const brief = item.brief.trim()
                if (!projectName || !brief)
                  return yield* new ToolFailure({ message: `${label}: both name and brief are required.` })
                if (names.has(projectName.toLowerCase()))
                  return yield* new ToolFailure({ message: `${label}: "${projectName}" appears twice.` })
                if (baseNames.has(projectName.toLowerCase()))
                  return yield* new ToolFailure({
                    message: `${label}: "${projectName}" is a base project and is created automatically. Pass only additional projects.`,
                  })
                names.add(projectName.toLowerCase())
                const team = item.team?.trim()
                const roleID = item.role?.trim()
                if (team && roleID)
                  return yield* new ToolFailure({ message: `${label}: choose either team or role, not both.` })
                if (team && !templates.some((template) => template.id === team))
                  return yield* new ToolFailure({ message: `${label}: unknown team template "${team}". Call list.` })
                const role = roleID ? roles.find((candidate) => candidate.id === roleID) : undefined
                if (roleID && !role)
                  return yield* new ToolFailure({ message: `${label}: unknown AI role "${roleID}". Call list.` })
                specs.push({ name: projectName, brief, ...(team ? { team } : {}), ...(role ? { role } : {}) })
              }

              const workerPolicy = yield* Orchestra.workerPolicy
              const created: Orchestra.Project[] = []
              const briefs = new Map<Orchestra.ProjectID, string>()
              const workerOf = (project: Orchestra.Project, role: Orchestra.Role) => {
                const choice = Orchestra.workerModels(workerPolicy, role)
                return orchestra.createMember({
                  project,
                  agent: role.agent,
                  title: role.name,
                  category: role.category,
                  model: choice.model,
                  models: choice.models,
                })
              }
              // Typed failures become a value so what was created can still be registered; interruption
              // and defects are not caught and travel on.
              const outcome = yield* Effect.result(
                Effect.gen(function* () {
                  // The base four are separate projects. The planner is the Society's first project, which
                  // already exists; the others are created unless an earlier generate already made them.
                  const first = group.projects[0] ? known.get(group.projects[0]) : undefined
                  for (const base of Federation.baseProjects) {
                    const role = roles.find((candidate) => candidate.id === base.role)
                    const present =
                      base.key === "planner"
                        ? first
                        : [...known.values()].find((item) => item.name.toLowerCase() === base.name.toLowerCase())
                    if (present) {
                      // An existing planner project gets its role session once, on the first generate.
                      if (base.key === "planner" && role && (yield* orchestra.sessions(present.id)).length === 0) {
                        yield* workerOf(present, role)
                        briefs.set(present.id, base.brief)
                      }
                      continue
                    }
                    const directory = yield* federation.societyFolder({ society: group.name, project: base.name })
                    const project = yield* orchestra.create({ name: base.name, directory })
                    created.push(project)
                    briefs.set(project.id, base.brief)
                    if (role) yield* workerOf(project, role)
                  }
                  for (const spec of specs) {
                    const directory = yield* federation.societyFolder({ society: group.name, project: spec.name })
                    const project = yield* orchestra.create({
                      name: spec.name,
                      directory,
                      ...(spec.team
                        ? {
                            template: spec.team,
                            workerModels: (role: Orchestra.Role | undefined) =>
                              Orchestra.workerModels(workerPolicy, role),
                          }
                        : {}),
                    })
                    created.push(project)
                    briefs.set(project.id, spec.brief)
                    if (spec.role) yield* workerOf(project, spec.role)
                  }
                }),
              )
              const failure = Result.isFailure(outcome) ? outcome.failure : undefined

              // Whatever was created joins the Society even if a later project failed, so no project is
              // left behind without a group.
              if (created.length > 0 || briefs.size > 0) yield* register(group, created, goal, briefs)
              if (failure)
                return yield* new ToolFailure({
                  message: [
                    `Stopped after ${created.length} projects: ${String(failure)}`,
                    created.length
                      ? `Already created and registered: ${created.map((project) => project.name).join(", ")}.`
                      : "Nothing was created.",
                  ].join("\n"),
                })

              return [
                `Generated ${created.length} project(s) in ${yield* federation.societyRoot(group.name)}:`,
                ...created.map((project) => `- ${project.name} (${project.id}) · ${project.directory}`),
                "Each project is linked to the others and has its brief. Use consult_all to hear from them.",
              ].join("\n")
            }).pipe(
              Effect.map((text) => ({ output: { output: text }, content: text })),
              Effect.mapError((error) =>
                error instanceof ToolFailure
                  ? error
                  : new ToolFailure({ message: `society_forge failed: ${String(error)}`, error }),
              ),
            ),
        }),
      )
      .pipe(Effect.orDie)

    // The chat must be the one its group registered as its Society; the marker alone proves nothing.
    function societyOf(sessionID: Parameters<typeof sessions.get>[0]) {
      return Effect.gen(function* () {
        const current = yield* sessions.get(sessionID).pipe(Effect.option)
        const marker = Option.isSome(current) ? FederationSchema.groupSupervisor(current.value.metadata) : undefined
        const group = marker
          ? (yield* federation.groups()).find(
              (item) =>
                item.supervisor === sessionID &&
                item.name === marker.groupName &&
                item.projects[0] === marker.leader &&
                FederationSchema.modeOf(item) === "council",
            )
          : undefined
        if (!group)
          return yield* new ToolFailure({
            message: "society_forge works only in a Society chat. This session is not the registered chat of a council group.",
          })
        return group
      })
    }

    function register(
      group: Federation.Group,
      created: readonly Orchestra.Project[],
      goal: string,
      briefs: ReadonlyMap<Orchestra.ProjectID, string>,
    ) {
      return Effect.gen(function* () {
        const members = [...group.projects, ...created.map((project) => project.id)]
        yield* federation.setGroup({ name: group.name, projects: members, mode: "council", supervisor: group.supervisor })
        // Pairs with every project listed before it: the coordinator, earlier members and earlier new ones.
        yield* Effect.forEach(
          created.flatMap((project) =>
            members.slice(0, members.indexOf(project.id)).map((other) => [project.id, other] as const),
          ),
          ([a, b]) => federation.link(a, b, { notify: false, trusted: true }),
          { discard: true },
        )
        const known = yield* orchestra.projects()
        const names = new Map(known.map((project) => [project.id, project.name]))
        // Every project that has a brief gets it, the existing planner included.
        yield* Effect.forEach(
          [...briefs],
          ([id, brief]) =>
            federation.brief({
              project: id,
              id: `society-brief-${id}`,
              text: briefText({
                society: group.name,
                project: names.get(id) ?? id,
                goal,
                brief,
                peers: members.filter((other) => other !== id).map((other) => names.get(other) ?? other),
              }),
            }),
          { discard: true },
        )
      })
    }
  }),
}

function briefText(input: { society: string; project: string; goal: string; brief: string; peers: readonly string[] }) {
  return [
    `<society-brief society="${escape(input.society)}" project="${escape(input.project)}">`,
    "This is your assignment from the operator's Society, written on the operator's behalf. Start now, without waiting for further confirmation.",
    `Society goal: ${escape(input.goal)}`,
    `Your assignment: ${escape(input.brief)}`,
    `Peer projects, linked to you: ${input.peers.map(escape).join(", ") || "none"}. Ask a peer with the federation tool when you need something from it; each peer's operator-side rules still apply.`,
    "Plan the work, delegate to your team with the sessions tool, and keep your project's files in your own folder.",
    "</society-brief>",
  ].join("\n")
}

// The lists go into the model's history and are re-sent on every later request.
const short = (text: string) => (text.length > 90 ? `${text.slice(0, 89)}…` : text)

const escape = (text: string) => text.replaceAll("<", "&lt;").replaceAll(">", "&gt;")
