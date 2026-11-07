import { createResource, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { createSimpleContext } from "./helper"
import { useClient } from "./client"

// The operator's own projects. The layout reads the count to decide whether the
// project tree takes room on the left; the tree and its dialogs read the list.
export const { use: useProjects, provider: ProjectsProvider } = createSimpleContext({
  name: "Projects",
  init: () => {
    const client = useClient()
    // A failed fetch must not resolve to an empty list: the tree would read it as
    // "zero projects" instead of "not loaded yet", and nothing would retry it.
    // Leave the resource pending/errored so `loaded()` stays false until a fetch succeeds.
    const [list, { refetch, mutate }] = createResource(() => client.api.orchestra.project.list())
    // The project that opened each session, so projects sharing a directory keep their own teams.
    const [owners, owner] = createResource(() => client.api.orchestra.owner.list())
    onCleanup(
      client.event.on("server.connected", () => {
        void refetch()
        void owner.refetch()
      }),
    )
    // Claims made here, kept apart so a refetch racing the server write cannot drop them.
    const [claimed, setClaimed] = createStore<Record<string, string>>({})
    // A project's orchestrator claims its new sessions before creating them, so the claim is already readable.
    // Creating a project also creates its Orchestrator, so the same event brings a project created
    // by an AI tool into the list instead of leaving its group with zero visible members.
    onCleanup(
      client.event.on("session.created", () => {
        void owner.refetch()
        void refetch()
      }),
    )
    return {
      list: () => list() ?? [],
      loaded: () => list() !== undefined,
      error: () => list.error,
      refetch: () => void refetch(),
      mutate,
      owner: (sessionID: string) => claimed[sessionID] ?? owners.latest?.[sessionID],
      // Shown at once; the server keeps it once the session exists. A failed create is reported by the prompt.
      claim: (sessionID: string, projectID: string, created: Promise<unknown>) => {
        setClaimed(sessionID, projectID)
        return created.then(
          () => client.api.orchestra.owner.set({ sessionID, projectID }),
          () => undefined,
        )
      },
    }
  },
})
