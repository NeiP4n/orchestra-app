import { ProjectTemplatesSimple, type ProjectTemplatesKeys, type ProjectTemplatesAccess } from "./project-templates-simple"
import { useClient } from "../context/client"
import { useProjects } from "../context/projects"
import { useRoute } from "../context/route"
import { useNotes } from "../context/notes"
import { useTuiPaths } from "../context/runtime"

/** The operator sees two actions. Current ownership, paths, fresh IDs and recovery tokens
 * remain implementation details; confirmation never starts a session or browser. */
export function ProjectTemplatesConnected(props: { keys?: (keys: ProjectTemplatesKeys) => void; scrollIntoView?: (id: string) => void }) {
  const client = useClient(),
    projects = useProjects(),
    route = useRoute(),
    notes = useNotes(),
    paths = useTuiPaths()
  const projectID = () => (route.data.type === "session" ? projects.owner(route.data.sessionID) : undefined)
  const browsers = () => {
    const id = projectID()
    if (!id) throw Error("Open a project first.")
    return notes.browserSessions(id).map((row) => ({
      id: row.id,
      name: row.name,
      ...(row.chat ? { chat: row.chat } : {}),
      mode: row.mode ?? ("window" as const),
    }))
  }
  // Remember the save's owner too: changing the selected chat while a confirmation is
  // open cannot silently export a different project's browser definitions.
  const saveOwners = new Map<string, string>()
  const access: ProjectTemplatesAccess = {
    list: () => client.api.orchestra.projectTemplate.list(),
    prepareSave: async (templateID) => {
      const id = projectID()
      if (!id) throw Error("Open a project first.")
      const prepared = await client.api.orchestra.projectTemplate.prepareSave({ projectID: id, browsers: browsers(), ...(templateID === undefined ? {} : { templateID }) })
      saveOwners.set(prepared.token, id)
      return prepared
    },
    confirmSave: async (token, omitUnsafeLinks, omitInvalidBrowserBindings, acceptUnresolvedRoles) => {
      if (saveOwners.get(token) !== projectID()) throw Error("Project changed after preview.")
      await client.api.orchestra.projectTemplate.confirmSave({ token, browsers: browsers(), omitUnsafeLinks, omitInvalidBrowserBindings, acceptUnresolvedRoles })
    },
    prepareCreate: (templateID) =>
      client.api.orchestra.projectTemplate.prepareCreate({
        templateID,
        settingsDirectory: projects.list().find((row) => row.id === projectID())?.directory ?? paths.cwd,
      }),
    confirmCreate: async (token) => {
      const result = await client.api.orchestra.projectTemplate.confirmCreate({ token })
      await notes.importBrowserDefinitions(result.browsers)
      await client.api.orchestra.projectTemplate.finishCreate({ token })
      projects.refetch()
    },
  }
  return <ProjectTemplatesSimple access={access} canSave={!!projectID()} keys={props.keys} scrollIntoView={props.scrollIntoView} />
}
