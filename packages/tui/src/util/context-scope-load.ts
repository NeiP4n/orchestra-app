import type { useClient } from "../context/client"
import { groupOf, projectOf, tokensOf, total, type Entry, type Loaded, type ProjectRef } from "./context-scope"

type Api = ReturnType<typeof useClient>["api"]

/**
 * Loads the sessions of the session's project, or the projects of its group.
 * A project's main session counts too; the project's session listing leaves it out.
 */
export async function loadScope(input: {
  api: Api
  scope: "project" | "group"
  sessionID: string
  directory: string | undefined
  signal: AbortSignal
}): Promise<Loaded> {
  const options = { signal: input.signal }
  const [projects, owners] = await Promise.all([
    input.api.orchestra.project.list(options),
    input.api.orchestra.owner.list(options),
  ])
  const project = projectOf({
    sessionID: input.sessionID,
    directory: input.directory,
    projects,
    owner: owners[input.sessionID],
  })

  if (!project) return { state: "no-project" }

  if (input.scope === "project")
    return { state: "ready", title: project.name, entries: await sessionEntries(input.api, project, options) }

  const group = groupOf(project.id, await input.api.orchestra.group.list(options))

  if (!group) return { state: "no-group", project: project.name }

  const members = group.projects.flatMap((id) => projects.find((item) => item.id === id) ?? [])
  const entries = await Promise.all(
    members.map(async (member): Promise<Entry> => {
      const sum = total(await sessionEntries(input.api, member, options))

      return { id: member.id, title: member.name, tokens: sum.tokens, cost: sum.cost }
    }),
  )

  return { state: "ready", title: group.name, entries }
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
