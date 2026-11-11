import { createMediaQuery } from "@solid-primitives/media"
import { createEffect, createMemo, createSignal, Show, untrack } from "solid-js"
import { ServerConnection } from "@/runtime/server/registry"
import { useLanguage } from "@/runtime/i18n/language"
import { useTabs, type DraftTab } from "@/shell/tabs/tabs"
import { ResolvedDraftRoute } from "@/new-session/route"
import { createHomeController } from "./model"
import { createHomeProjectsController } from "./projects/controller"
import { HomeUtilityNav } from "./projects/view"
import { HomeProjects } from "./projects/region"
import { createHomeScrollController } from "./scroll"
import { createHomeSessionSearchController } from "./sessions/search"
import { createHomeSessionsController } from "./sessions/controller"
import { HomeSessions } from "./sessions/region"
import "./workspace.css"

export function Home() {
  const mobile = createMediaQuery("(max-width: 899px)")
  const home = createHomeController()
  const projects = createHomeProjectsController(home)
  const sessions = createHomeSessionsController(home)
  const search = createHomeSessionSearchController(home, sessions)
  const scroll = createHomeScrollController(sessions.data.groups)
  const tabs = useTabs()
  const language = useLanguage()
  const [draft, setDraft] = createSignal<DraftTab>()

  const current = createMemo(() => {
    const server = home.server.focused()
    const project = home.project.newSession()

    return server && project ? { server: ServerConnection.key(server), directory: project.worktree } : undefined
  })

  createEffect(() => {
    const target = current()

    if (!tabs.ready() || !target) {
      setDraft(undefined)

      return
    }

    setDraft(untrack(() => tabs.ensureHomeDraft(target)))
  })

  const context = home.server.focusedContext

  const roots = createMemo(
    () =>
      context()
        ?.data.session.list()
        .filter((session) => !session.parentID) ?? [],
  )

  const thinking = createMemo(
    () => roots().filter((session) => context()?.data.session.status(session.id) === "running").length,
  )

  const connected = () => context()?.sdk.connection.status() === "connected"

  return (
    <div data-slot="home-panel" data-component="tui-workspace">
      <aside data-slot="tui-project-tree" aria-label={language.t("home.projects")}>
        <HomeProjects projects={projects} scroll={scroll} dropdown={mobile()} />
        <Show when={mobile()}>
          <details data-slot="tui-mobile-sessions">
            <summary>◉ {language.t("sidebar.project.recentSessions")}</summary>
            <div data-slot="tui-session-tree">
              <HomeSessions sessions={sessions} search={search} scroll={scroll} />
            </div>
          </details>
        </Show>
        <Show when={!mobile()}>
          <div data-slot="tui-session-tree">
            <HomeSessions sessions={sessions} search={search} scroll={scroll} />
          </div>
          <HomeUtilityNav
            class="flex"
            onOpenSettings={projects.utility.settings}
            onOpenHelp={projects.utility.help}
            language={projects.copy.language}
          />
        </Show>
      </aside>
      <main data-slot="tui-home-stage">
        <Show when={draft()} keyed fallback={<div data-slot="tui-empty-stage">{language.t("home.projects")}</div>}>
          {(draft) => <ResolvedDraftRoute draft={draft} />}
        </Show>
      </main>
      <aside data-slot="tui-project-overview" aria-label={language.t("home.overview.title")}>
        <h2>◉ {language.t("home.overview.title")}</h2>
        <section>
          <h3>{language.t("home.overview.directory")}</h3>
          <p dir="ltr">{current()?.directory ?? "·"}</p>
        </section>
        <section data-slot="tui-network-overview">
          <h3>{language.t("home.overview.network")}</h3>
          <dl>
            <dt>{language.t("home.overview.sessions")}</dt>
            <dd>{roots().length}</dd>
            <dt>{language.t("home.overview.thinking")}</dt>
            <dd>{thinking()}</dd>
            <dt>{language.t("home.overview.server")}</dt>
            <dd>{language.t(connected() ? "home.overview.connected" : "home.overview.connecting")}</dd>
          </dl>
        </section>
      </aside>
    </div>
  )
}
