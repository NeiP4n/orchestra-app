import type { useClient } from "../context/client"
import {
  groupOf,
  projectOf,
  societyOf,
  supervisedGroup,
  tokensOf,
  total,
  type Entry,
  type Loaded,
  type ProjectRef,
} from "./context-scope"

type Api = ReturnType<typeof useClient>["api"]

/**
 * Loads the sessions of the session's project, the projects of its group, or every project of its
 * Society. A project's main session counts too; the project's session listing leaves it out. The
 * Society scope also counts the Society's own chat, because it is a session that spends on the
 * same goal.
 */
export async function loadScope(input: {
  api: Api
  scope: "project" | "group" | "society"
  sessionID: string
  directory: string | undefined
  signal: AbortSignal
}): Promise<Loaded> {
  const options = { signal: input.signal }
  const [projects, owners, groups] = await Promise.all([
    input.api.orchestra.project.list(options),
    input.api.orchestra.owner.list(options),
    input.api.orchestra.group.list(options),
  ])
  const chat = supervisedGroup(input.sessionID, groups)
  const project = chat
    ? undefined
    : projectOf({
        sessionID: input.sessionID,
        directory: input.directory,
        projects,
        owner: owners[input.sessionID],
      })

  if (input.scope === "project") {
    if (!project) return { state: "no-project" }
    return { state: "ready", title: project.name, entries: await sessionEntries(input.api, project, options) }
  }

  if (input.scope === "group") {
    const group = chat ?? (project ? groupOf(project.id, groups) : undefined)
    if (!group) return project ? { state: "no-group", project: project.name } : { state: "no-project" }
    return { state: "ready", title: group.name, entries: await groupEntries(input.api, group, projects, options) }
  }

  const society = chat ?? (project ? societyOf(project.id, groups) : undefined)
  if (!society) return project ? { state: "no-society", project: project.name } : { state: "no-project" }
  const entries = await groupEntries(input.api, society, projects, options)
  const own = society.supervisor
    ? await input.api.session.get({ sessionID: society.supervisor }, options).catch(() => undefined)
    : undefined
  return {
    state: "ready",
    title: society.name,
    entries: own
      ? [
          ...entries,
          {
            id: own.id,
            title: own.title ?? society.name,
            tokens: tokensOf(own.tokens),
            cost: own.cost,
          },
        ]
      : entries,
  }
}

async function groupEntries(
  api: Api,
  group: { projects: ReadonlyArray<string> },
  projects: ReadonlyArray<ProjectRef>,
  options: { signal: AbortSignal },
) {
  const members = group.projects.flatMap((id) => projects.find((item) => item.id === id) ?? [])
  return Promise.all(
    members.map(async (member): Promise<Entry> => {
      const sum = total(await sessionEntries(api, member, options))
      return { id: member.id, title: member.name, tokens: sum.tokens, cost: sum.cost }
    }),
  )
}

async function sessionEntries(api: Api, project: ProjectRef, options: { signal: AbortSignal }) {
  const [listed, main] = await Promise.all([
    api.orchestra.project.sessions({ projectID: project.id }, options),
    project.main ? api.session.get({ sessionID: project.main }, options) : undefined,
  ])

  return [...(main ? [main] : []), ...listed.data].map(
    (session): Entry => ({
      id: session.id,
      title: session.title ?? session.id,
      tokens: tokensOf(session.tokens),
      cost: session.cost,
    }),
  )
}
