export * as SocietyForgeTool from "./society-forge.js"

import { ToolFailure } from "@orchestra/ai"
import type { Context } from "@orchestra/plugin/effect/plugin"
import { Federation as FederationSchema } from "@orchestra/schema/federation"
import { Effect, Option, Schema } from "effect"
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
  action: Schema.Literals(["list", "generate"]),
  goal: Schema.optionalKey(Schema.String).annotate({
    description: "For generate: the operator's goal in their own words. Every project's Orchestrator receives it.",
  }),
  projects: Schema.optionalKey(Schema.Array(Project)).annotate({
    description: `For generate: the projects the goal needs, 1 to ${MAX_PROJECTS}.`,
  }),
})
export const Output = Schema.Struct({ output: Schema.String })

const guide = [
  "society_forge builds the Society's projects from the operator's goal. It exists only in a Society chat.",
  "Call action=list first for exact team-template and role IDs. When no template fits a project, create the missing role or team with team_forge first, then use its ID.",
  `Then call action=generate once with goal and every project the goal needs (at most ${MAX_PROJECTS}). Decide the split yourself: do not ask the operator for names, folders or teams the goal already implies.`,
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
            "Generate the projects of a Society from a goal. Available only in a Society (council group) chat. Actions: list, generate.",
            "generate creates each project in the Society's folder with its Orchestrator and team, links the projects to each other and delivers every brief.",
          ].join("\n"),
          input: Input,
          output: Output,
          execute: (input, context) =>
            Effect.gen(function* () {
              const group = yield* societyOf(context.sessionID)
              const templates = yield* orchestra.templates()
              const roles = yield* orchestra.roles()

              if (input.action === "list") {
                const projects = yield* orchestra.projects()
                return [
                  `Society "${group.name}" · folder ${Federation.societyDirectory(group.name)}`,
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
              if (wanted.length === 0 || wanted.length > MAX_PROJECTS)
                return yield* new ToolFailure({ message: `generate needs between 1 and ${MAX_PROJECTS} projects.` })

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
              const failure = yield* Effect.forEach(
                specs,
                (spec) =>
                  Effect.gen(function* () {
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
                    if (!spec.role) return
                    const choice = Orchestra.workerModels(workerPolicy, spec.role)
                    yield* orchestra.createMember({
                      project,
                      agent: spec.role.agent,
                      title: spec.role.name,
                      category: spec.role.category,
                      model: choice.model,
                      models: choice.models,
                    })
                  }),
                { concurrency: 1, discard: true },
              ).pipe(
                Effect.as(undefined),
                Effect.catchCause((cause) => Effect.succeed(cause)),
              )

              // Whatever was created joins the Society even if a later project failed, so no project is
              // left behind without a group.
              if (created.length > 0) yield* register(group, created, goal, specs)
              if (failure)
                return yield* new ToolFailure({
                  message: [
                    `Stopped after ${created.length} of ${specs.length} projects: ${String(failure)}`,
                    created.length ? `Already created and registered: ${created.map((project) => project.name).join(", ")}.` : "Nothing was created.",
                  ].join("\n"),
                })

              return [
                `Generated ${created.length} project(s) in ${Federation.societyDirectory(group.name)}:`,
                ...created.map((project, index) => {
                  const spec = specs[index]
                  const setup = spec?.team ? `team ${spec.team}` : spec?.role ? `role ${spec.role.id}` : "Orchestrator only"
                  return `- ${project.name} (${project.id}) · ${project.directory} · ${setup}`
                }),
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
      specs: ReadonlyArray<{ readonly name: string; readonly brief: string }>,
    ) {
      return Effect.gen(function* () {
        const members = [...group.projects, ...created.map((project) => project.id)]
        yield* federation.setGroup({ name: group.name, projects: members, mode: "council", supervisor: group.supervisor })
        // Pairs with every project listed before it: the coordinator, earlier members and earlier new ones.
        yield* Effect.forEach(
          created.flatMap((project) =>
            members.slice(0, members.indexOf(project.id)).map((other) => [project.id, other] as const),
          ),
          ([a, b]) => federation.link(a, b, { notify: false }),
          { discard: true },
        )
        const known = yield* orchestra.projects()
        const names = new Map(known.map((project) => [project.id, project.name]))
        yield* Effect.forEach(
          created,
          (project, index) =>
            federation.brief({
              project: project.id,
              id: `society-brief-${project.id}`,
              text: briefText({
                society: group.name,
                project: project.name,
                goal,
                brief: specs[index]?.brief ?? "",
                peers: members.filter((id) => id !== project.id).map((id) => names.get(id) ?? id),
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
