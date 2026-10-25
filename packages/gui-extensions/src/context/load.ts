import type { OpenCodeClient } from "@orchestra/client/promise"
import { groupOf, projectOf, total, type Entry, type ProjectRef } from "./scope"

/** What the project or group scope shows: the rows to list, or why there are none. */
export type Loaded =
  | { state: "no-project" }
  | { state: "no-group"; project: string }
  | { state: "ready"; title: string; entries: Entry[] }

type Client = Pick<OpenCodeClient, "orchestra" | "session">

/**
 * Loads the sessions of the routed session's project, or the projects of its group.
 * A project with a main session counts it too; the project listing leaves it out.
 */
export async function loadScope(input: {
  client: Client
  scope: "project" | "group"
  sessionID: string
  directory: string | undefined
  signal: AbortSignal
}): Promise<Loaded> {
  const options = { signal: input.signal }

  const [projects, owners] = await Promise.all([
    input.client.orchestra.project.list(options),
    input.client.orchestra.owner.list(options),
  ])

  const project = projectOf({ sessionID: input.sessionID, directory: input.directory, projects, owners })

  if (!project) return { state: "no-project" }

  if (input.scope === "project")
    return { state: "ready", title: project.name, entries: await sessionEntries(input.client, project, options) }

  const group = groupOf(project.id, await input.client.orchestra.group.list(options))

  if (!group) return { state: "no-group", project: project.name }

  const members = group.projects.flatMap((id) => projects.find((item) => item.id === id) ?? [])

  const entries = await Promise.all(
    members.map(async (member): Promise<Entry> => {
      const sum = total(await sessionEntries(input.client, member, options))

      return { id: member.id, title: member.name, tokens: sum.tokens, cost: sum.cost }
    }),
  )

  return { state: "ready", title: group.name, entries }
}

async function sessionEntries(client: Client, project: ProjectRef, options: { signal: AbortSignal }) {
  const [listed, main] = await Promise.all([
    client.orchestra.project.sessions({ projectID: project.id }, options),
    project.main ? client.session.get({ sessionID: project.main }, options) : undefined,
  ])

  return [...(main ? [main] : []), ...listed.data].map(
    (session): Entry => ({
      id: session.id,
      title: session.title ?? session.id,
      tokens: session.tokens,
      cost: session.cost,
    }),
  )
}
