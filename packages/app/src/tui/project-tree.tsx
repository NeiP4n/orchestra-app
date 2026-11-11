import { useParams } from "@solidjs/router"
import { createEffect } from "solid-js"
import { createHomeController } from "@/home/model"
import { createHomeProjectsController } from "@/home/projects/controller"
import { HomeProjects } from "@/home/projects/region"
import { HomeUtilityNav } from "@/home/projects/view"
import { createHomeScrollController } from "@/home/scroll"
import { createHomeSessionsController } from "@/home/sessions/controller"
import { createHomeSessionSearchController } from "@/home/sessions/search"
import { HomeSessions } from "@/home/sessions/region"
import { useGlobal } from "@/runtime/server/runtime"
import { requireServerKey } from "@/shell/routes/session"
import "@/home/workspace.css"

// Use the same live projects, session actions and search as Home. A route
// change selects the current session's project without opening a new draft.
export function TuiProjectTree() {
  const home = createHomeController()
  const projects = createHomeProjectsController(home)
  const sessions = createHomeSessionsController(home)
  const search = createHomeSessionSearchController(home, sessions)
  const scroll = createHomeScrollController(sessions.data.groups)
  const global = useGlobal()
  const params = useParams<{ serverKey?: string; id?: string }>()

  createEffect(() => {
    if (!params.serverKey || !params.id) return
    const server = requireServerKey(params.serverKey)
    const context = global.serverCtx(server)
    const directory = context?.data.session.get(params.id)?.location.directory

    if (!context || !directory) return
    const project = context.projects
      .list()
      .find((item) => item.worktree === directory || item.sandboxes?.includes(directory))

    home.selection.set({ server, directory: project?.worktree ?? directory })
  })

  return (
    <aside data-slot="tui-project-tree" aria-label={projects.copy.language.t("home.projects")}>
      <HomeProjects projects={projects} scroll={scroll} />
      <div data-slot="tui-session-tree">
        <HomeSessions sessions={sessions} search={search} scroll={scroll} />
      </div>
      <HomeUtilityNav
        class="flex"
        onOpenSettings={projects.utility.settings}
        onOpenHelp={projects.utility.help}
        language={projects.copy.language}
      />
    </aside>
  )
}
