import { TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createEffect, createMemo, createResource, createSignal, For, on, onCleanup, onMount, Show, untrack, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import type {
  OrchestraAccess,
  OrchestraProject,
  RoomBan,
  RoomInfo,
  RoomMemberView,
  SessionInfo,
} from "@orchestra/client/promise"
import { Federation } from "@orchestra/schema/federation"
import { Orchestra } from "@orchestra/schema/orchestra"
import { owningProject } from "../util/project-owner"
import { Mode } from "@orchestra/schema/mode"
import { useClient } from "../context/client"
import { useData } from "../context/data"
import { useRoute } from "../context/route"
import { useTheme } from "../context/theme"
import { useDialog } from "../ui/dialog"
import { useToast } from "../ui/toast"
import { errorMessage } from "../util/error"
import { roomListChanged, roomListRevision, sameRoom, useJoinedRooms, type JoinedRoom } from "../util/room"
import { DialogConnect, DialogHost, DialogMesh, nextMemberRole, ROLE_LABEL } from "./dialog-rooms"
import { roomClient, tellHostLeft, unlinkRoom } from "../util/room-guest"
import { DialogGroups } from "./dialog-groups"
import { openProjectDialog } from "./dialog-project"
import { useProjects } from "../context/projects"
import { browserSessionGroups, openedFromProjects } from "../util/browser-sessions"
import { DialogPrompt } from "../ui/dialog-prompt"
import { DialogSessionRename } from "./dialog-session-rename"
import { DialogSelect } from "../ui/dialog-select"
import { DialogRules } from "./dialog-rules"
import * as BrowserRuntime from "../util/browser-runtime"
import { DialogConfirm } from "../ui/dialog-confirm"
import { ClearSessionsAction } from "./clear-sessions"
import { useNotes, type NotesTab } from "../context/notes"
import { NotesPanel } from "./notes-panel"
import { Row } from "./panel-row"
import { RoomDodRows } from "./room-dod"
import { HoverAction } from "./hover-action"
import { DialogMode } from "./dialog-mode"
import { useNow } from "./note-canvas"
import { useT } from "../util/i18n"
import { tint } from "../theme/color"
import { hoverBackground } from "../ui/hover"
import { Branch, NeuralChip, NeuralLine, NeuronDot, neuralPalette, useNeuralEnergy } from "./neural"
import { AllSessionsField, useEmptyRoom } from "./session-network"

// The left panel: the operator's own projects, each a name and a directory,
// with its main session (the orchestrator) and the sessions opened in that
// directory under it, grouped by category. "#" sets a session's category; the
// chip after it is the access the orchestrator has to it, and clicking it steps
// through the levels. Below the projects, Multiplayer lists the sessions this
// computer hosts as rooms and the rooms it joined on other hosts. The Host dialog
// includes a Mesh mode. The Notes tab swaps the tree for notes.

const ACCESS_ORDER: readonly OrchestraAccess[] = ["hidden", "read", "write", "full"]

// Sessions shown under one expanded project before the rest fold behind a
// "+ N more" row. A team project accumulates a session per role and attempt;
// listing all of them buries every other project in the panel.
const SESSION_LIMIT = 8

export function ProjectTree(props: { width: number; collapsed?: boolean; onHide?: () => void; onShow?: () => void }) {
  const t = useT()
  const client = useClient()
  const data = useData()
  const route = useRoute()
  const theme = useTheme()
  const toast = useToast()
  const dialog = useDialog()
  const projectList = useProjects()
  const projects = projectList.list
  const notes = useNotes()
  const [rooms] = createResource(roomListRevision, () => client.api.room.list().catch(() => []))
  const [meshStatus, { refetch: refreshMesh }] = createResource(() =>
    client.api.room.mesh.status().catch(() => undefined),
  )
  onMount(() => {
    const timer = setInterval(() => void refreshMesh(), 2000)
    onCleanup(() => clearInterval(timer))
  })
  // Groups the operator keeps projects in. The dialog changes them, so they are read again as it closes.
  // A failed fetch resolves to no groups, not an empty list: the tree must not
  // present "zero groups" while the first load is still failing.
  const [groups, { refetch: refreshGroups }] = createResource(() => client.api.orchestra.group.list())
  onMount(() => {
    const timer = setInterval(() => {
      void refreshGroups()
      // The project list has no other retry: a first fetch that failed while the
      // server was still starting would otherwise leave the tree at zero projects
      // until the next reconnect or session creation.
      if (!projectList.loaded()) void projectList.refetch()
    }, 3000)
    onCleanup(() => clearInterval(timer))
  })
  const [groupClosed, setGroupClosed] = createStore<Record<string, boolean>>({})
  // Opening a group's chat must not trust the stored supervisor id: the chat can be deleted
  // (clear all sessions, a failed create, a mode change) while the group still names it, and
  // navigating straight to that id dead-links on "Session not found". The server owns the group
  // chat and self-heals it in the group's own directory, so ask it for the live session and open
  // whatever it returns.
  const [openingGroup, setOpeningGroup] = createSignal<string>()
  const openGroupChat = (name: string) => {
    if (openingGroup()) return
    setOpeningGroup(name)
    void client.api.orchestra.group
      .chat({ name })
      .then((chat) => {
        void refreshGroups()
        route.navigate({ type: "session", sessionID: chat.sessionID })
      })
      .catch((error: unknown) => toast.show({ message: errorMessage(error), variant: "error" }))
      .finally(() => setOpeningGroup(undefined))
  }
  // Societies whose AIs are held: none of their sessions runs until the operator releases them. The server holds
  // every Society when it starts, so nothing begins working by itself.
  const [holds, { refetch: refreshHolds }] = createResource(() =>
    client.api.orchestra.group.holds().catch(() => [] as string[]),
  )
  const held = (name: string) => (holds.latest ?? []).includes(name)
  const toggleHold = (name: string) =>
    void client.api.orchestra.group
      .hold({ name, held: !held(name) })
      .then(() => refreshHolds())
      .catch((error: unknown) => toast.show({ message: errorMessage(error), variant: "error" }))
  // Groups first, each with the projects it holds; a project in several groups appears in the first only.
  // Projects in no group follow without a heading.
  // A refetch parses fresh objects for unchanged data, and a new reference alone
  // remounts the row mid-press. Keep the previous object while the server's data
  // is unchanged so the tree patches in place instead.
  let projectCache = new Map<string, OrchestraProject>()
  const stableProject = (project: OrchestraProject) => {
    const prev = projectCache.get(project.id)
    if (prev !== undefined && JSON.stringify(prev) === JSON.stringify(project)) return prev
    projectCache.set(project.id, project)
    return project
  }
  const computeSections = () => {
    const seen = new Set<string>()
    const named = (groups.latest ?? []).map((group) => {
      const council = (group.mode ?? "lead") === "council"
      const members = group.projects.flatMap((id) => {
        const project = projects().find((item) => item.id === id)
        return project ? [stableProject(project)] : []
      })
      return {
        name: group.name as string | undefined,
        supervisor: group.supervisor as string | undefined,
        chat: (council ? t("Society") : t("President")) as string | undefined,
        // The Society dispatches the Orchestrator of every member; the President speaks for one, the coordinator's.
        orchestrators: (council ? members : members.slice(0, 1)).filter((project) => project.main !== undefined),
        projects: group.projects.flatMap((id) => {
          const project = projects().find((item) => item.id === id)
          if (!project || seen.has(id)) return []
          seen.add(id)
          return [stableProject(project)]
        }),
      }
    })
    return [
      ...named,
      {
        name: undefined as string | undefined,
        supervisor: undefined as string | undefined,
        chat: undefined as string | undefined,
        orchestrators: [] as OrchestraProject[],
        projects: projects()
          .filter((item) => !seen.has(item.id))
          .map(stableProject),
      },
    ]
  }
  const sections = createMemo(() => {
    const list = computeSections()
    // Drop cache entries for projects no longer listed so the map cannot grow past the tree.
    const live = new Set(list.flatMap((section) => [...section.orchestrators, ...section.projects].map((project) => project.id)))
    for (const id of projectCache.keys()) if (!live.has(id)) projectCache.delete(id)
    return list
  })
  // The tree keys sections by name, not object identity: a refresh that changes one
  // project replaces only that project's row; an unchanged row in the same section is
  // preserved, and a press held on it survives. Group names are unique and non-empty
  // (the server stores groups keyed by name and rejects an empty one), so the unnamed
  // section's "" key can never shadow a group. Renaming a group or moving a project
  // between groups legitimately remounts the rows involved.
  const sectionKeys = createMemo(() => sections().map((section) => section.name ?? ""))
  const emptySection: ReturnType<typeof computeSections>[number] = {
    name: undefined,
    supervisor: undefined,
    chat: undefined,
    orchestrators: [],
    projects: [],
  }
  const sectionByKey = (key: string) => sections().find((section) => (section.name ?? "") === key) ?? emptySection
  const isSociety = (section: { name?: string; supervisor?: string; chat?: string }) =>
    section.name !== undefined && section.supervisor !== undefined && section.chat === t("Society")
  // A Society is a crew of several projects and stays folded until opened, so two of them do not bury the
  // panel; the one holding the open session is shown unfolded.
  const closed = (section: { name?: string; supervisor?: string; chat?: string; projects: readonly OrchestraProject[] }) => {
    if (!section.name) return false
    const chosen = groupClosed[section.name]
    if (chosen !== undefined) return chosen
    if (!isSociety(section)) return false
    const open = current()?.id
    return !(
      open !== undefined &&
      (section.supervisor === open ||
        section.projects.some((project) => project.main === open || sessionsOf(project).some((session) => session.id === open)))
    )
  }
  const [joined, updateJoined] = useJoinedRooms()
  const [expanded, setExpanded] = createStore<Record<string, boolean>>({})
  const [showAll, setShowAll] = createStore<Record<string, boolean>>({})
  const [access, setAccess] = createStore<Record<string, OrchestraAccess>>({})
  const [category, setCategory] = createStore<Record<string, string | undefined>>({})
  const [hover, setHoverState] = createSignal<string>()
  // Destructive actions require two clicks. Do not disarm them just because a label reflows
  // under the pointer after the first click; terminals can emit mouse-out during that reflow.
  const [armed, setArmedState] = createSignal<string>()
  let armTimer: ReturnType<typeof setTimeout> | undefined
  const clearArmed = () => {
    if (armTimer !== undefined) clearTimeout(armTimer)
    armTimer = undefined
    setArmedState()
  }
  const arm = (id: string) => {
    if (armTimer !== undefined) clearTimeout(armTimer)
    setArmedState(id)
    armTimer = setTimeout(() => {
      if (armed() === id) setArmedState()
      armTimer = undefined
    }, 4_000)
  }
  const setHover = (id: string | undefined) => {
    // Hover may briefly move between children when a label changes width. Confirmation is
    // cleared by a different destructive action or by timeout, never by pointer bookkeeping.
    setHoverState(id)
  }
  onCleanup(() => {
    if (armTimer !== undefined) clearTimeout(armTimer)
  })
  // Hidden as soon as the delete succeeds; the server's deleted event drops the record later.
  const [removed, setRemoved] = createStore<Record<string, boolean>>({})

  const current = () => (route.data.type === "session" ? data.session.get(route.data.sessionID) : undefined)
  // The Console and Browser views are per project: the tree lists only projects there, and picking one
  // opens its main session, whose directory decides the shell (or the browser sessions) shown.
  const projectOnly = () => notes.tab() === "console" || notes.tab() === "browser"
  const inProject = (project: OrchestraProject) =>
    current()?.location.directory !== undefined &&
    owningProject(projects(), current()!.location.directory)?.id === project.id
  const palette = () => neuralPalette(theme)
  const energy = useNeuralEnergy()
  const empty = useEmptyRoom()
  const dimensions = useTerminalDimensions()
  // A narrow panel keeps the switch as two icons so the names below get the room.
  const iconOnly = () => props.width < 36
  // A narrow panel keeps session titles readable by showing the category and access controls
  // only on the hovered session.
  const narrow = () => props.width < 36
  const shared = createMemo(() => new Set((rooms.latest ?? []).map((room) => room.sessionID)))
  const owner = (session: Pick<SessionInfo, "id" | "location" | "metadata">) => {
    const claimed = projectList.owner(session.id) ?? Orchestra.sessionOwner(session.metadata)
    // A group chat belongs to its group, not to the project whose directory happens to contain it.
    if (claimed === undefined && Federation.groupSupervisor(session.metadata) !== undefined) return undefined
    return Orchestra.ownerOf(projects(), session.location.directory, claimed)
  }

  const sessionProject = () => {
    const session = current()
    return session && projects().find((item) => item.main === session.id || owner(session)?.id === item.id)
  }

  // The project of the open session starts expanded so the tree shows where you are.
  createEffect(() => {
    const project = sessionProject()
    if (project && expanded[project.id] === undefined) void expand(project.id)
  })

  // Opening a session makes its project the one the Notes tab shows.
  createEffect(
    on(
      () => sessionProject()?.id,
      (projectID) => {
        if (projectID && projectID !== notes.project()) notes.setProject(projectID)
      },
    ),
  )

  const expand = async (projectID: string) => {
    setExpanded(projectID, true)
    await client.api.orchestra.project
      .sessions({ projectID })
      .then((result) => {
        result.data.forEach((session) => data.session.remember(session))
        setAccess(result.access)
        setCategory(result.category)
      })
      .catch((error: unknown) => toast.show({ message: errorMessage(error), variant: "error" }))
  }

  // Categories and access come from the server with the project's session list, once, when the project opens. A
  // session the Orchestrator creates later (with its category) was in the list but not in the category map, so it
  // landed under "Other" until the project was reopened. When the set of sessions an open project owns changes,
  // the map is fetched again (one request at a time per project, a short wait so a burst of creates is one fetch).
  const seenSessions = new Map<string, string>()
  const refreshing = new Set<string>()
  const refreshTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const refresh = (projectID: string) => {
    if (refreshing.has(projectID)) return
    refreshing.add(projectID)
    void client.api.orchestra.project
      .sessions({ projectID })
      .then((result) => {
        result.data.forEach((session) => data.session.remember(session))
        setAccess(result.access)
        setCategory(result.category)
      })
      .catch(() => undefined)
      .finally(() => refreshing.delete(projectID))
  }
  createEffect(() => {
    const list = data.session.list()
    for (const project of projects()) {
      const signature = list
        .filter((session) => owner(session)?.id === project.id)
        .map((session) => session.id)
        .toSorted()
        .join(",")
      const before = seenSessions.get(project.id)
      seenSessions.set(project.id, signature)
      if (before === undefined || before === signature || !untrack(() => expanded[project.id])) continue
      clearTimeout(refreshTimers.get(project.id))
      refreshTimers.set(
        project.id,
        setTimeout(() => refresh(project.id), 400),
      )
    }
  })
  onCleanup(() => refreshTimers.forEach((timer) => clearTimeout(timer)))

  const toggle = (projectID: string) => {
    notes.setProject(projectID)
    if (expanded[projectID]) return setExpanded(projectID, false)
    void expand(projectID)
  }

  // The closed browser sessions of a project: pick one to bring back (same profile, same name), or remove it from the
  // list. Removing the profile folder too (logins, cookies) is its own key and asks first.
  const openClosedPicker = (project: OrchestraProject) => {
    const closed = () => notes.closedBrowserSessions(project.id)
    const again = () => (closed().length > 0 ? openClosedPicker(project) : dialog.clear())
    // A confirm dialog clears the dialog stack right after its callbacks, so what follows waits one tick.
    const next = (fn: () => void) => void setTimeout(fn, 0)
    dialog.replace(() => (
      <DialogSelect
        title={t("Reopen a closed browser session")}
        options={closed().map((item) => ({
          title: item.group ? `${item.group} · ${item.name}` : item.name,
          value: item.id,
          description: new Date(item.closedAt).toLocaleString(),
        }))}
        onSelect={(option) => {
          dialog.clear()
          notes.reopenBrowserSession(project.id, option.value)
          notes.setProject(project.id)
          if (!inProject(project)) void openMain(project)
        }}
        actions={[
          {
            command: "dialog.browser.forget",
            title: t("remove from list"),
            bind: "ctrl+d",
            onTrigger: (option) => {
              notes.forgetClosedBrowserSession(project.id, option.value)
              again()
            },
          },
          {
            command: "dialog.browser.erase",
            title: t("delete with logins"),
            bind: "ctrl+x",
            onTrigger: (option) => {
              const name = closed().find((item) => item.id === option.value)?.name ?? option.title
              dialog.replace(() => (
                <DialogConfirm
                  title={t("Delete browser session")}
                  message={`${name}: ${t("deletes the saved Chrome profile (logins, cookies, history). This cannot be undone.")}`}
                  label={{ confirm: t("Delete"), cancel: t("Keep") }}
                  onConfirm={() => {
                    const failed = BrowserRuntime.deleteProfile(option.value)
                    if (failed) {
                      next(() =>
                        dialog.replace(() => (
                          <DialogConfirm
                            title={t("Could not delete")}
                            message={failed}
                            onConfirm={() => next(again)}
                            onCancel={() => next(again)}
                          />
                        )),
                      )
                      return
                    }
                    notes.forgetClosedBrowserSession(project.id, option.value)
                    next(again)
                  }}
                  onCancel={() => next(again)}
                />
              ))
            },
          },
        ]}
      />
    ))
  }
  const openMain = (project: OrchestraProject) => {
    if (project.main) {
      route.navigate({ type: "session", sessionID: project.main })
    }
    return client.api.orchestra.project
      .main({ projectID: project.id })
      .then((session) => {
        data.session.remember(session)
        projectList.mutate((list) => {
          const items = list ?? []
          if (items.some((item) => item.id === project.id))
            return items.map((item) => (item.id === project.id ? { ...item, main: session.id } : item))
          // The create response may beat the projects-list refetch. Keep the freshly created
          // project visible instead of silently dropping it from an initially empty resource.
          return [...items, { ...project, main: session.id }]
        })
        if (!project.main) {
          route.navigate({ type: "session", sessionID: session.id })
        }
      })
      .catch((error: unknown) => {
        if (!project.main) {
          toast.show({ message: errorMessage(error), variant: "error" })
        }
      })
  }

  const openCreatedProject = async (project: OrchestraProject) => {
    setExpanded(project.id, true)
    // Refresh the roster in the background; opening the project's main session must not
    // depend on a second endpoint responding first.
    void expand(project.id)
    // Return the promise so DialogProject keeps its completion lifecycle in the right order:
    // finish opening the orchestrator, then close the dialog and refresh the project list.
    await openMain(project)
  }

  const edit = (project?: OrchestraProject) =>
    openProjectDialog(dialog, projectList.refetch, project, undefined, project ? undefined : openCreatedProject)

  const cycle = (sessionID: string) => {
    const now = access[sessionID] ?? Orchestra.defaultAccess
    const next = ACCESS_ORDER[(ACCESS_ORDER.indexOf(now) + 1) % ACCESS_ORDER.length]
    setAccess(sessionID, next)
    void client.api.orchestra.access({ sessionID, access: next }).catch((error: unknown) => {
      setAccess(sessionID, now)
      toast.show({ message: errorMessage(error), variant: "error" })
    })
  }

  const categorize = (sessionID: string) =>
    dialog.replace(() => (
      <DialogPrompt
        title={t("Session category")}
        placeholder={t("Planning, Build, Quality… (empty removes it)")}
        value={category[sessionID] ?? ""}
        onCancel={() => dialog.clear()}
        onConfirm={(value) => {
          dialog.clear()
          const previous = category[sessionID]
          setCategory(sessionID, value.trim() || undefined)
          void client.api.orchestra.category({ sessionID, category: value.trim() }).catch((error: unknown) => {
            setCategory(sessionID, previous)
            toast.show({ message: errorMessage(error), variant: "error" })
          })
        }}
      />
    ))

  const remove = (sessionID: string) => {
    if (armed() !== sessionID) return arm(sessionID)
    clearArmed()
    void client.api.session
      .remove({ sessionID })
      .then(() => {
        setRemoved(sessionID, true)
        // A browser session whose BrowserAgent chat was deleted here must not keep pointing at it (the Browser tab
        // would open a chat that is gone).
        notes.forgetBrowserChat(sessionID)
        data.session.evict(sessionID)
        if (route.data.type === "session" && route.data.sessionID === sessionID) route.navigate({ type: "home" })
      })
      .catch((error: unknown) => toast.show({ message: errorMessage(error), variant: "error" }))
  }

  const roomKey = (room: JoinedRoom) => `room:${room.url}#${room.roomID}`
  const openRoom = (room: JoinedRoom, sessionID?: string) =>
    route.navigate({ type: "room", url: room.url, roomID: room.roomID, sessionID })
  const viewing = (room: JoinedRoom) => route.data.type === "room" && sameRoom(route.data, room)

  // Leaving tells the host and forgets the token here; the host keeps the room and its chat.
  const leave = (room: JoinedRoom) => {
    if (armed() !== roomKey(room)) return arm(roomKey(room))
    clearArmed()
    if (viewing(room)) route.navigate({ type: "home" })
    void tellHostLeft(room)
    void unlinkRoom(client.api, room)
    void updateJoined((draft) => {
      draft.joined = draft.joined.filter((item) => !sameRoom(item, room))
    })
  }

  // Closing a room stops sharing its session: the session stays, every guest token stops working.
  const stopHosting = (roomID: string) => {
    if (armed() !== `hosted:${roomID}`) return arm(`hosted:${roomID}`)
    clearArmed()
    void client.api.room
      .remove({ roomID })
      .then(() => roomListChanged())
      .catch((error: unknown) => toast.show({ message: errorMessage(error), variant: "error" }))
  }

  const openRooms = (window: typeof DialogHost | typeof DialogConnect) => {
    dialog.replace(() => window({ onClose: () => dialog.clear() }), undefined, { size: "large" })
    dialog.setCentered(true)
  }
  const openGroups = () => {
    dialog.replace(
      () => (
        <DialogGroups
          onClose={() => {
            dialog.clear()
            void refreshGroups()
          }}
        />
      ),
      undefined,
      { size: "large" },
    )
    dialog.setCentered(true)
  }
  const openMesh = () => {
    dialog.replace(() => <DialogMesh onClose={() => dialog.clear()} />, undefined, { size: "large" })
    dialog.setCentered(true)
  }

  const leaveMesh = () => {
    if (armed() !== "mesh:leave") return arm("mesh:leave")
    clearArmed()
    void client.api.room.mesh
      .leave()
      .then(() => refreshMesh())
      .catch((error: unknown) => toast.show({ message: errorMessage(error), variant: "error" }))
  }

  // The answer settles once: the dialog can be confirmed, cancelled or closed.
  const confirmClear = (options: {
    title: string
    message: string
    label: { confirm: string; cancel: string }
  }) =>
    new Promise<boolean | undefined>((resolve) => {
      let answered = false
      const done = (value: boolean | undefined) => {
        if (answered) return
        answered = true
        resolve(value)
      }
      dialog.replace(
        () => (
          <DialogConfirm
            title={options.title}
            message={options.message}
            label={options.label}
            onConfirm={() => done(true)}
            onCancel={() => done(false)}
          />
        ),
        () => done(undefined),
      )
    })

  // Subagents (sessions with a parent) are listed under their parent, running ones first, so a task the Orchestrator
  // handed off can be found: "↳ <title> · <role> · <status>". At most CHILD_LIMIT per parent, the rest as a count.
  const CHILD_LIMIT = 30
  const childrenOf = (parentID: string | undefined) => {
    if (parentID === undefined) return { shown: [], more: 0 }
    const all = data.session
      .list()
      .filter((item) => item.parentID === parentID && !removed[item.id] && !isBrowserRole(item.agent) && !/browser/i.test(item.title ?? ""))
      .toSorted((a, b) => Number(data.session.status(b.id) === "running") - Number(data.session.status(a.id) === "running"))
    return { shown: all.slice(0, CHILD_LIMIT), more: Math.max(0, all.length - CHILD_LIMIT) }
  }
  const childRows = (parentID: string | undefined, depth = 1): JSX.Element => {
    const found = childrenOf(parentID)
    return (
      <>
        <For each={found.shown}>
          {(child) => (
            <>
            <Row
              id={`child:${child.id}`}
              hover={hover}
              setHover={setHover}
              selected={child.id === current()?.id}
              onClick={() => route.navigate({ type: "session", sessionID: child.id })}
            >
              <Branch lit={child.id === current()?.id || hover() === `child:${child.id}`} />
              <text flexShrink={0} fg={theme.text.muted}>
                {`${"  ".repeat(depth)}${data.session.status(child.id) === "running" ? "↳ ● " : "↳ ○ "}`}
              </text>
              <box flexGrow={1} minWidth={0}>
              <text fg={theme.text.muted} wrapMode="none" truncate>
                {`${child.title || t("Untitled")} · ${String(child.agent ?? "").replace(/^team-/, "") || "subagent"} · ${
                  waiting().has(child.id) ? t("waiting") : data.session.status(child.id) === "running" ? t("running") : t("idle")
                }`}
              </text>
              </box>
              {rowButtons(child)}
            </Row>
            {childRows(child.id, depth + 1)}
            </>
          )}
        </For>
        <Show when={found.more > 0}>
          <box flexDirection="row" paddingLeft={1}>
            <Branch through />
            <text fg={theme.text.muted} wrapMode="none">{`    + ${found.more} ${t("more subagents")}`}</text>
          </box>
        </Show>
      </>
    )
  }

  // The browser sessions of a project with reopen and new. Shown in the Browser tab and, always, as the "Browsers"
  // group of the project tree.
  const browserRows = (project: OrchestraProject): JSX.Element => (
    <>
                  <For each={browserSessionGroups(notes.browserSessions(project.id)).flatMap((group) => group.sessions)}>
                    {(item) => {
                      const [removeHovered, setRemoveHovered] = createSignal(false)
                      const chosen = () => notes.browserSelected(project.id)?.id === item.id
                      return (
                        <>
                        <Row
                          id={`browser:${item.id}`}
                          hover={hover}
                          setHover={setHover}
                          selected={chosen() && inProject(project)}
                          onClick={() => {
                            notes.selectBrowserSession(project.id, item.id)
                            notes.ensureBrowserAgent(project.id, item.id, project.directory)
                            notes.setProject(project.id)
                            // From the Projects tab the row opens only its chat; the tab stays (the user's explicit pick).
                            if (notes.tab() !== "browser" && item.chat) {
                              if (!(route.data.type === "session" && route.data.sessionID === item.chat)) openedFromProjects.add(item.chat)
                              route.navigate({ type: "session", sessionID: item.chat })
                              return
                            }
                            if (!inProject(project)) void openMain(project)
                          }}
                        >
                          <Branch lit={chosen() && inProject(project)} />
                          <text flexShrink={0} fg={chosen() ? palette().synapse : theme.text.muted}>
                            {"◎ "}
                          </text>
                          <box flexGrow={1} minWidth={0}>
                            <text fg={theme.text.base} wrapMode="none" truncate>
                              {item.group ? `${item.group} · ${item.name}` : item.name}
                            </text>
                          </box>
                          <HoverAction
                            id={`browser-rename:${item.id}`}
                            onClick={() =>
                              dialog.replace(() => (
                                <DialogPrompt
                                  title={t("Rename browser session")}
                                  placeholder={t("Name (logins and cookies stay)")}
                                  value={item.name}
                                  onCancel={() => dialog.clear()}
                                  onConfirm={(value) => {
                                    dialog.clear()
                                    notes.renameBrowserSession(project.id, item.id, value)
                                  }}
                                />
                              ))
                            }
                          >
                            <text fg={theme.text.action.primary.base}>{" ✎ "}</text>
                          </HoverAction>
                          <HoverAction
                            id={`browser-remove:${item.id}`}
                            onMouseEnter={() => setRemoveHovered(true)}
                            onMouseLeave={() => setRemoveHovered(false)}
                            onClick={() => notes.removeBrowserSession(project.id, item.id)}
                          >
                            <text fg={removeHovered() ? theme.text.feedback.error.base : theme.text.muted}>{" × "}</text>
                          </HoverAction>
                        </Row>
                        </>
                      )
                    }}
                  </For>
                  <Show when={notes.closedBrowserSessions(project.id).length > 0}>
                    <Row
                      id={`browser-reopen:${project.id}`}
                      hover={hover}
                      setHover={setHover}
                      onClick={() => openClosedPicker(project)}
                    >
                      <Branch />
                      <text fg={theme.text.action.primary.base} wrapMode="none" truncate>
                        {`↺ ${t("Reopen closed session")} (${notes.closedBrowserSessions(project.id).length})`}
                      </text>
                    </Row>
                  </Show>
                  <Row
                    id={`browser-new:${project.id}`}
                    hover={hover}
                    setHover={setHover}
                    onClick={() => {
                      notes.addBrowserSession(project.id, project.directory)
                      notes.setProject(project.id)
                      if (!inProject(project)) void openMain(project)
                    }}
                  >
                    <Branch last />
                    <text fg={theme.text.action.primary.base} wrapMode="none" truncate>
                      {`+ ${t("New browser session")}`}
                    </text>
                  </Row>
    </>
  )

  // A subagent whose chain of parents does not end at the Orchestrator or at a session listed in this project would be
  // listed nowhere (its parent is hidden, in another project, or not loaded), so it is listed as a session of its own.
  const orphan = (parentID: string, project: OrchestraProject) => {
    const list = data.session.list()
    let current = list.find((item) => item.id === parentID)
    for (let hops = 0; current && hops < 8; hops++) {
      if (current.id === project.main) return false
      if (!current.parentID) {
        const root = current
        return (
          isBrowserRole(root.agent) || /browser/i.test(root.title ?? "") ||
          owner(root)?.id !== project.id
        )
      }
      const up: string = current.parentID
      current = list.find((item) => item.id === up)
    }
    return true
  }

  // Rename and delete for a row of any kind (subagent, BrowserAgent chat, plain session). Deleting asks once ("delete?"),
  // then removes the session on the server and clears what points at it (remove()).
  const rowButtons = (session: { id: string; title?: string }, rename = true) => {
    const [hovered, setHovered] = createSignal(false)
    return (
      <>
        <Show when={rename}>
          <HoverAction
            id={`session-rename:${session.id}`}
            onClick={() => dialog.replace(() => <DialogSessionRename sessionID={session.id} currentTitle={session.title} />)}
          >
            <text fg={theme.text.action.primary.base}>{" ✎ "}</text>
          </HoverAction>
        </Show>
        <HoverAction
          id={`session-delete:${session.id}`}
          variant="destructive"
          onMouseEnter={() => setHover(session.id)}
          onMouseLeave={() => setHover(session.id)}
          onHoverChange={setHovered}
          onClick={() => remove(session.id)}
        >
          <text fg={hovered() ? theme.text.action.destructive.hovered : armed() === session.id ? theme.text.feedback.error.base : theme.text.muted}>
            {armed() === session.id ? ` ${t("delete?")} ` : " × "}
          </text>
        </HoverAction>
      </>
    )
  }

  // Every session of a browser role (the BrowserAgent, or a role the Orchestrator made for page work such as
  // "team-browser-registration-agent"), subagents included, is listed in the Browsers group, never beside the sessions.
  const isBrowserRole = (agent: string | undefined) => agent !== undefined && /browser/i.test(agent)
  // A session is a browser one by its agent id, or its title ("Browser 2", "Browser Registration Agent"), or because a
  // browser record owns it as its chat. Several signs on purpose: the Orchestrator makes these through different paths.
  const ownedByBrowserRecord = (project: OrchestraProject, id: string) =>
    [...notes.browserSessions(project.id), ...notes.closedBrowserSessions(project.id)].some((item) => item.chat === id)
  const isBrowserSession = (project: OrchestraProject, session: { id: string; agent?: string; title?: string }) =>
    isBrowserRole(session.agent) || /browser/i.test(session.title ?? "") || ownedByBrowserRecord(project, session.id)

  // BrowserAgent chats no browser session owns (the Orchestrator created them) belong to the Browsers group too.
  const browserChatsOf = (project: OrchestraProject) =>
    data.session
      .list()
      .filter(
        (session) =>
          (isBrowserRole(session.agent) || /browser/i.test(session.title ?? "")) &&
          !removed[session.id] &&
          !ownedByBrowserRecord(project, session.id) &&
          owner(session)?.id === project.id,
      )

  const sessionsOf = (project: OrchestraProject) =>
    data.session
      .list()
      .filter(
        (session) =>
          (!session.parentID || orphan(session.parentID, project)) &&
          !removed[session.id] &&
          session.id !== project.main &&
          // A BrowserAgent chat belongs to its browser session and is listed in the Browser tab, not here. One that no
          // browser session owns (the Orchestrator created it with sessions create) would be listed nowhere, so it stays here.
          !isBrowserSession(project, session) &&
          owner(session)?.id === project.id,
      )

  // A chat the AI is waiting on: a pending question or permission request, subagents included.
  // Only running sessions can ask, so those are the ones worth syncing.
  const waiting = createMemo(
    () =>
      new Set([...data.session.permission.sessions(), ...data.session.form.sessions()].map((id) => data.session.root(id))),
  )
  createEffect(() =>
    data.session.active().forEach((id) => {
      void data.session.permission.sync(id).catch(() => undefined)
      void data.session.form.sync(id).catch(() => undefined)
    }),
  )
  const projectWaiting = (project: OrchestraProject) =>
    [project.main, ...sessionsOf(project).map((session) => session.id)].some((id) => id !== undefined && waiting().has(id))

  const thinking = (project: OrchestraProject) =>
    [project.main, ...sessionsOf(project).map((session) => session.id)].some(
      (id) => id !== undefined && data.session.status(id) === "running",
    )

  // The groups actually rendered: capped at SESSION_LIMIT sessions unless the
  // operator asked for all of them. The open session is always kept, so the
  // tree still shows where you are even when it sits past the cap.
  const visibleGroupsOf = (project: OrchestraProject) => {
    const groups = groupsOf(project)
    const total = groups.reduce((count, group) => count + group.sessions.length, 0)
    if (showAll[project.id] || total <= SESSION_LIMIT) return { groups, hidden: 0, total }
    const open = current()?.id
    let budget = SESSION_LIMIT
    const visible = groups
      .map((group) => ({
        ...group,
        sessions: group.sessions.filter((session) => {
          if (budget > 0) {
            budget--
            return true
          }
          return session.id === open
        }),
      }))
      .filter((group) => group.sessions.length > 0)
    const shown = visible.reduce((count, group) => count + group.sessions.length, 0)
    return { groups: visible, hidden: total - shown, total }
  }

  // Categories in first-seen order; sessions without one come last, under "Other"
  // only when the project uses categories at all.
  const groupsOf = (project: OrchestraProject) => {
    const sessions = sessionsOf(project)
    const names = [...new Set(sessions.flatMap((session) => category[session.id] ?? []))]
    const rest = sessions.filter((session) => !category[session.id])
    return [
      ...names.map((name) => ({ name, sessions: sessions.filter((session) => category[session.id] === name) })),
      ...(rest.length > 0 ? [{ name: names.length > 0 ? t("Other") : "", sessions: rest }] : []),
    ]
  }

  return (
    <Show
      when={!props.collapsed}
      fallback={
        <box
          width={props.width}
          height="100%"
          flexShrink={0}
          backgroundColor={theme.background.raised.base}
          border={["right"]}
          borderColor={theme.border.base}
          paddingTop={1}
        >
          <HoverAction id="project-tree.show" onClick={() => props.onShow?.()} paddingLeft={1} paddingRight={1}>
            <text fg={theme.text.action.primary.base}>›</text>
          </HoverAction>
        </box>
      }
    >
      <box width={props.width} height="100%" flexShrink={0} backgroundColor={theme.background.raised.base} paddingTop={1}>
        {/* The panel's head: a segmented switch between the tree and the notes, the main action, and collapse. */}
        <box flexDirection="row" flexWrap="wrap" paddingLeft={1} paddingRight={1} columnGap={1} rowGap={0} flexShrink={0}>
          {/* Tabs wrap to a second row when the panel is narrow, so none is clipped. */}
          <box flexDirection="row" flexWrap="wrap" flexShrink={1}>
            <Tab tab="projects" icon="◉" label={iconOnly() ? "" : t("Projects")} hover={hover} setHover={setHover} />
            <Tab tab="notes" icon="✎" label={iconOnly() ? "" : t("Notes")} hover={hover} setHover={setHover} />
            <Tab tab="console" icon="›_" label={iconOnly() ? "" : t("Console")} hover={hover} setHover={setHover} />
            <Tab tab="browser" icon="◎" label={iconOnly() ? "" : t("Browser")} hover={hover} setHover={setHover} />
          </box>
          <box flexGrow={1} />
          <NeuralChip
            id="project-tree.new"
            icon="+"
            label={props.width < 30 ? "" : t("New")}
            accent
            onClick={() => (notes.tab() === "notes" ? notes.setCreating(true) : edit())}
          />
          <Show when={props.onHide}>
            <HoverAction id="project-tree.hide" onClick={() => props.onHide?.()} paddingLeft={1} paddingRight={1}>
              <text fg={palette().synapse}>‹</text>
            </HoverAction>
          </Show>
        </box>
        {/* Decoration goes first on a short window: the tree needs every row. */}
        <Show when={dimensions().height >= 24} fallback={<box height={1} flexShrink={0} />}>
          <box paddingLeft={1} paddingRight={1} paddingTop={1} paddingBottom={1} flexShrink={0}>
            <NeuralLine energy={energy()} seed={5} backdrop={theme.background.raised.base} />
          </box>
        </Show>
        <Show when={notes.tab() === "notes"}>
          <ProjectNotes />
        </Show>
        <box
          visible={notes.tab() !== "notes"}
          flexGrow={notes.tab() !== "notes" ? 1 : 0}
          minHeight={0}
          position="relative"
          onSizeChange={function () {
            empty.area(this.height)
          }}
        >
        <scrollbox flexGrow={1} minHeight={0} horizontalScrollbarOptions={{ visible: false }}>
          <box
            flexShrink={0}
            onSizeChange={function () {
              empty.content(this.height)
            }}
          >
          <Section
            title={t("Projects")}
            icon="◉"
            // No count while the list is still loading: 0 here would claim the
            // operator has no projects.
            count={projectList.loaded() ? projects().length : undefined}
            actions={<SectionAction id="groups:new" label={t("+ Group")} onClick={openGroups} />}
          >
          <Show when={!projectList.loaded()}>
            <box paddingLeft={1} flexShrink={0}>
              <text fg={theme.text.muted}>{t("loading…")}</text>
            </box>
          </Show>
          <Show when={groups.error}>
            <box paddingLeft={1} flexShrink={0}>
              <text fg={theme.text.feedback.error.base}>{t("Couldn't load groups")}</text>
            </box>
          </Show>
          <For each={sectionKeys()}>
            {(key) => {
              const section = () => sectionByKey(key)
              return (
              <>
                <Show when={section().name}>
                  <Row
                    id={`group:${section().name}`}
                    hover={hover}
                    setHover={setHover}
                    onClick={() => setGroupClosed(section().name!, !closed(section()))}
                  >
                    <text flexShrink={0} fg={theme.text.muted}>
                      {closed(section()) ? "▸ " : "▾ "}
                    </text>
                    <box flexGrow={1} minWidth={0}>
                      <text fg={theme.text.muted} attributes={TextAttributes.BOLD} wrapMode="none" truncate>
                        {section().name}
                        <Show when={projectList.loaded()}>
                          <span style={{ fg: theme.text.muted }}>{` · ${section().projects.length}`}</span>
                        </Show>
                      </text>
                    </box>
                    {/* The switch that keeps a Society's AIs from working: held, none of its sessions starts. */}
                    <Show when={isSociety(section())}>
                      <HoverAction
                        id={`group-hold:${section().name}`}
                        onMouseEnter={() => setHover(`group:${section().name}`)}
                        onMouseLeave={() => setHover(`group:${section().name}`)}
                        onClick={() => toggleHold(section().name!)}
                      >
                        <text
                          fg={held(section().name!) ? theme.text.feedback.warning.base : theme.text.muted}
                          attributes={held(section().name!) ? TextAttributes.BOLD : undefined}
                        >
                          {held(section().name!) ? ` ⏸ ${t("held")} ` : " ⏸ "}
                        </text>
                      </HoverAction>
                    </Show>
                    <HoverAction
                      id={`group-edit:${section().name}`}
                      onMouseEnter={() => setHover(`group:${section().name}`)}
                      onMouseLeave={() => setHover(`group:${section().name}`)}
                      onClick={openGroups}
                    >
                      <text fg={theme.text.action.primary.base}>
                        {hover() === `group:${section().name}` ? " ✱" : "  "}
                      </text>
                    </HoverAction>
                  </Row>
                </Show>
                <Show when={!section().name || !closed(section())}>
                  {/* The group's own chat lives outside every project, so the group is the only
                      place the left panel can show it. */}
                  <Show when={section().supervisor}>
                    <box paddingLeft={2}>
                      <Row
                        id={`group-chat:${section().name}`}
                        hover={hover}
                        setHover={setHover}
                        selected={section().supervisor === current()?.id}
                        onClick={() => openGroupChat(section().name!)}
                      >
                        <Branch lit={section().supervisor === current()?.id} />
                        <text flexShrink={0} fg={palette().spark}>
                          {"★ "}
                        </text>
                        <text fg={theme.text.base} wrapMode="none" truncate>
                          {`${section().chat} · ${section().orchestrators.length}`}
                        </text>
                      </Row>
                      <For each={section().orchestrators}>
                        {(project) => (
                          <Row
                            id={`group-orchestrator:${section().name}:${project.id}`}
                            hover={hover}
                            setHover={setHover}
                            selected={project.main !== undefined && project.main === current()?.id}
                            onClick={() => void openMain(project)}
                          >
                            <Branch through />
                            <Branch last />
                            <text flexShrink={0} fg={palette().synapse}>
                              {"◆ "}
                            </text>
                            <text fg={theme.text.base} wrapMode="none" truncate>
                              {project.name}
                            </text>
                          </Row>
                        )}
                      </For>
                    </box>
                  </Show>
                  <For each={section().projects}>
                    {(project) => (
                      <box paddingLeft={section().name ? 2 : 0}>
                <Row
                  id={project.id}
                  hover={hover}
                  setHover={setHover}
                  selected={projectOnly() && inProject(project)}
                  onClick={() => {
                    if (!projectOnly()) return toggle(project.id)
                    notes.setProject(project.id)
                    void openMain(project)
                  }}
                >
                  {/* A project is a neuron: lit while any of its sessions works, open when expanded. */}
                  <text
                    flexShrink={0}
                    fg={
                      thinking(project)
                        ? palette().signal
                        : expanded[project.id] || hover() === project.id
                          ? palette().synapse
                          : theme.text.muted
                    }
                  >
                    {projectOnly() ? (inProject(project) ? "◉ " : "○ ") : expanded[project.id] ? "◉ " : "○ "}
                  </text>
                  <box flexGrow={1} minWidth={0}>
                    <text fg={theme.text.base} attributes={TextAttributes.BOLD} wrapMode="none" truncate>
                      {project.name}
                    </text>
                  </box>
                  {/* Visible while the project is collapsed, so a question is never hidden in a folded tree. */}
                  <Show when={projectWaiting(project)}>
                    <text flexShrink={0} fg={theme.text.feedback.warning.base} attributes={TextAttributes.BOLD}>
                      {" ? "}
                    </text>
                  </Show>
                  <HoverAction
                    id={`project-edit:${project.id}`}
                    onMouseEnter={() => setHover(project.id)}
                    onMouseLeave={() => setHover(project.id)}
                    onClick={() => edit(project)}
                  >
                    {/* Only the hovered project shows its settings, so the names are not lined with gears. */}
                    <text fg={theme.text.action.primary.base}>{hover() === project.id ? " ✱" : "  "}</text>
                  </HoverAction>
                </Row>
                {/* Browser view: the project's browser sessions, any number, each its own profile. */}
                <Show when={notes.tab() === "browser"}>
                  {browserRows(project)}
                </Show>
                <Show when={expanded[project.id] && !projectOnly()}>
                  {/* The rulebooks of this project: the crew's rules, and the rules only its Orchestrator gets (operator-only). */}
                  <Row
                    hover={hover}
                    setHover={setHover}
                    onClick={() => dialog.replace(() => <DialogRules scope={`project:${project.id}`} title={project.directory} />)}
                  >
                    <Branch />
                    <text fg={theme.text.muted} wrapMode="none" truncate>{`§ ${t("Project rules")}`}</text>
                  </Row>
                  <Row
                    hover={hover}
                    setHover={setHover}
                    onClick={() => dialog.replace(() => <DialogRules scope={`orchestrator:${project.id}`} title={`${t("Orchestrator")}: ${project.directory}`} />)}
                  >
                    <Branch />
                    <text fg={theme.text.muted} wrapMode="none" truncate>{`§ ${t("Orchestrator rules")}`}</text>
                  </Row>
                  <Row
                    id={`${project.id}:main`}
                    hover={hover}
                    setHover={setHover}
                    selected={project.main !== undefined && project.main === current()?.id}
                    onClick={() => void openMain(project)}
                  >
                    <Branch lit={project.main !== undefined && project.main === current()?.id} />
                    <text flexShrink={0} fg={palette().spark}>
                      {"★ "}
                    </text>
                    <text
                      fg={project.main !== undefined && waiting().has(project.main) ? theme.text.feedback.warning.base : theme.text.base}
                      attributes={project.main !== undefined && waiting().has(project.main) ? TextAttributes.BOLD : undefined}
                      wrapMode="none"
                      truncate
                    >
                      {project.main !== undefined && waiting().has(project.main) ? `? ${t("Orchestrator")}` : t("Orchestrator")}
                    </text>
                  </Row>
                  {childRows(project.main)}
                  <Show when={notes.tab() !== "browser"}>
                  <box flexDirection="row" paddingLeft={1}>
                    <Branch through />
                    <text fg={palette().synapse} wrapMode="none" truncate>
                      {`# ${t("Browsers")}`}
                    </text>
                  </box>
                  {browserRows(project)}
                  <For each={browserChatsOf(project)}>
                    {(chat) => (
                      <Row
                        id={`browser-chat:${chat.id}`}
                        hover={hover}
                        setHover={setHover}
                        selected={chat.id === current()?.id}
                        onClick={() => route.navigate({ type: "session", sessionID: chat.id })}
                      >
                        <Branch lit={chat.id === current()?.id} />
                        <text flexShrink={0} fg={theme.text.muted}>{"◎ "}</text>
                        <box flexGrow={1} minWidth={0}>
                          <text fg={theme.text.base} wrapMode="none" truncate>{chat.title || t("Browser agent")}</text>
                        </box>
                        {rowButtons(chat)}
                      </Row>
                    )}
                  </For>
                  </Show>
                  <For each={visibleGroupsOf(project).groups}>
                    {(group) => (
                      <>
                        <Show when={group.name}>
                          <box flexDirection="row" paddingLeft={1}>
                            <Branch through />
                            <text fg={palette().synapse} wrapMode="none" truncate>
                              {`# ${group.name}`}
                            </text>
                          </box>
                        </Show>
                        <For each={group.sessions}>
                          {(session) => {
                            const [modeHovered, setModeHovered] = createSignal(false)
                            const [categoryHovered, setCategoryHovered] = createSignal(false)
                            const [accessHovered, setAccessHovered] = createSignal(false)
                            const [deleteHovered, setDeleteHovered] = createSignal(false)
                            return (
                            <>
                            <Row
                              id={session.id}
                              hover={hover}
                              setHover={setHover}
                              selected={session.id === current()?.id}
                              onClick={() => route.navigate({ type: "session", sessionID: session.id })}
                            >
                              <Branch lit={session.id === current()?.id || hover() === session.id} />
                              {/* A working session is a firing neuron. */}
                              <Show
                                when={waiting().has(session.id)}
                                fallback={
                                  <Show
                                    when={data.session.status(session.id) === "running"}
                                    fallback={
                                      <text flexShrink={0} fg={hover() === session.id ? palette().synapse : theme.text.muted}>
                                        ○
                                      </text>
                                    }
                                  >
                                    <NeuronDot energy={0.9} />
                                  </Show>
                                }
                              >
                                <text flexShrink={0} fg={theme.text.feedback.warning.base} attributes={TextAttributes.BOLD}>
                                  ?
                                </text>
                              </Show>
                              <text flexShrink={0}> </text>
                              <box flexGrow={1} minWidth={0}>
                                <text
                                  fg={waiting().has(session.id) ? theme.text.feedback.warning.base : theme.text.base}
                                  attributes={waiting().has(session.id) ? TextAttributes.BOLD : undefined}
                                  wrapMode="none"
                                  truncate
                                >
                                  {`${shared().has(session.id) ? "⇄ " : ""}${session.title || t("Untitled")}`}
                                </text>
                              </box>
                              <Show when={!narrow() || hover() === session.id}>
                                <HoverAction
                                  id={`session-mode:${session.id}`}
                                  onMouseEnter={() => setHover(session.id)}
                                  onMouseLeave={() => setHover(session.id)}
                                  onHoverChange={setModeHovered}
                                  onClick={() => DialogMode.show(dialog, session.id)}
                                >
                                  <text fg={modeHovered() ? theme.text.action.primary.hovered : theme.text.action.primary.base}>
                                    {` ${Mode.fromMetadata(session.metadata)?.id ?? "auto"} `}
                                  </text>
                                </HoverAction>
                                <HoverAction
                                  id={`session-category:${session.id}`}
                                  onMouseEnter={() => setHover(session.id)}
                                  onMouseLeave={() => setHover(session.id)}
                                  onHoverChange={setCategoryHovered}
                                  onClick={() => categorize(session.id)}
                                >
                                  <text fg={categoryHovered() ? theme.text.action.primary.hovered : theme.text.muted}>
                                    {" # "}
                                  </text>
                                </HoverAction>
                                <HoverAction
                                  id={`session-access:${session.id}`}
                                  onMouseEnter={() => setHover(session.id)}
                                  onMouseLeave={() => setHover(session.id)}
                                  onHoverChange={setAccessHovered}
                                  onClick={() => cycle(session.id)}
                                >
                                  <text fg={accessHovered() ? theme.text.action.primary.hovered : theme.text.base}>{`[${access[session.id] ?? Orchestra.defaultAccess}]`}</text>
                                </HoverAction>
                              </Show>
                              <HoverAction
                                id={`session-rename:${session.id}`}
                                onClick={() =>
                                  dialog.replace(() => <DialogSessionRename sessionID={session.id} currentTitle={session.title} />)
                                }
                              >
                                <text fg={theme.text.action.primary.base}>{" ✎ "}</text>
                              </HoverAction>
                              <HoverAction
                                id={`session-delete:${session.id}`}
                                variant="destructive"
                                onMouseEnter={() => setHover(session.id)}
                                onMouseLeave={() => setHover(session.id)}
                                onHoverChange={setDeleteHovered}
                                onClick={() => remove(session.id)}
                              >
                                <text
                                  fg={
                                    deleteHovered()
                                      ? theme.text.action.destructive.hovered
                                      : armed() === session.id
                                        ? theme.text.feedback.error.base
                                        : theme.text.muted
                                  }
                                >
                                  {armed() === session.id ? ` ${t("delete?")} ` : " × "}
                                </text>
                              </HoverAction>
                            </Row>
                            {childRows(session.id)}
                            </>
                            )
                          }}
                        </For>
                      </>
                    )}
                  </For>
                  <Show when={visibleGroupsOf(project).hidden > 0}>
                    <Row
                      id={`${project.id}:more`}
                      hover={hover}
                      setHover={setHover}
                      onClick={() => setShowAll(project.id, true)}
                    >
                      <Branch />
                      <text fg={theme.text.muted}>{t("+ {count} more", { count: visibleGroupsOf(project).hidden })}</text>
                    </Row>
                  </Show>
                  <Show when={showAll[project.id] && visibleGroupsOf(project).total > SESSION_LIMIT}>
                    <Row
                      id={`${project.id}:less`}
                      hover={hover}
                      setHover={setHover}
                      onClick={() => setShowAll(project.id, false)}
                    >
                      <Branch />
                      <text fg={theme.text.muted}>{t("Show less")}</text>
                    </Row>
                  </Show>
                  <Row
                    id={`${project.id}:new`}
                    hover={hover}
                    setHover={setHover}
                    onClick={() =>
                      route.navigate({ type: "home", location: { directory: project.directory }, project: project.id })
                    }
                  >
                    <Branch last />
                    <text fg={hover() === `${project.id}:new` ? palette().signal : theme.text.muted}>
                      {t("+ New session")}
                    </text>
                  </Row>
                </Show>
                      </box>
                    )}
                  </For>
                </Show>
              </>
              )
            }}
          </For>
          </Section>
          <Section title={t("Multiplayer")} icon="⇄" gap>
            <box flexDirection="row" flexWrap="wrap" gap={1} paddingBottom={1}>
              <SectionButton icon="◈" label={t("Host")} onClick={() => openRooms(DialogHost)} />
              <SectionButton icon="⇢" label={t("Connect")} onClick={() => openRooms(DialogConnect)} />
            </box>
            <Show when={meshStatus() && meshStatus()!.status !== "unconfigured"}>
              <Row
                id="mesh:connected"
                hover={hover}
                setHover={setHover}
                onClick={openMesh}
              >
                <text flexShrink={0} fg={theme.text.action.secondary.base}>
                  {"  ⇄ "}
                </text>
                <box flexGrow={1} minWidth={0}>
                  <text fg={theme.text.base} attributes={TextAttributes.BOLD} wrapMode="none" truncate>
                    {t("Mesh")} · {meshStatus()!.clusterID ?? t("connected")}
                  </text>
                  <text fg={theme.text.muted} wrapMode="none" truncate>
                    {meshStatus()!.status === "active"
                      ? meshStatus()!.leaderID
                        ? t("active · coordinator {id}", { id: meshStatus()!.leaderID ?? "" })
                        : t("active · electing coordinator")
                      : t("waiting for members")}
                  </text>
                </box>
                <HoverAction
                  id="mesh:leave"
                  onMouseEnter={() => setHover("mesh:connected")}
                  onMouseLeave={() => setHover("mesh:connected")}
                  onClick={leaveMesh}
                >
                  <text
                    fg={
                      armed() === "mesh:leave"
                        ? theme.text.action.destructive.focused
                        : theme.text.action.destructive.base
                    }
                  >
                    {armed() === "mesh:leave" ? " leave?" : " × "}
                  </text>
                </HoverAction>
              </Row>
            </Show>
            <RoomPeople rooms={rooms.latest ?? []} hover={hover} setHover={setHover} />
            <For each={rooms.latest ?? []}>
              {(room) => (
                <>
                  <Row
                    id={`hosted:${room.id}`}
                    hover={hover}
                    setHover={setHover}
                    selected={room.sessionID === current()?.id}
                    onClick={() => route.navigate({ type: "session", sessionID: room.sessionID })}
                  >
                    <text flexShrink={0} fg={theme.text.action.secondary.base}>
                      {"  ⇄ "}
                    </text>
                    <box flexGrow={1} minWidth={0}>
                      <text fg={theme.text.base} wrapMode="none" truncate>
                        {room.name}
                      </text>
                    </box>
                    <HoverAction
                      id={`hosted-close:${room.id}`}
                      onMouseEnter={() => setHover(`hosted:${room.id}`)}
                      onMouseLeave={() => setHover(`hosted:${room.id}`)}
                      onClick={() => stopHosting(room.id)}
                    >
                      <text
                        fg={
                          armed() === `hosted:${room.id}`
                            ? theme.text.action.destructive.focused
                            : theme.text.action.destructive.base
                        }
                      >
                        {armed() === `hosted:${room.id}` ? ` ${t("close?")}` : " × "}
                      </text>
                    </HoverAction>
                  </Row>
                  <RoomDodRows
                    id={`hosted:${room.id}`}
                    hover={hover}
                    setHover={setHover}
                    load={() => client.api.room.dod.get({ roomID: room.id })}
                    loadBoard={() => client.api.room.dod.board({ roomID: room.id })}
                    release={(id) => client.api.room.dod.release({ roomID: room.id, id })}
                    feed={(after, wait) => client.api.room.feed({ roomID: room.id, after, wait })}
                  />
                </>
              )}
            </For>
            <For each={joined.joined}>
              {(room) => (
                <>
                  <Row
                    id={roomKey(room)}
                    hover={hover}
                    setHover={setHover}
                    selected={viewing(room) && route.data.type === "room" && !route.data.sessionID}
                    onClick={() => openRoom(room)}
                  >
                    <text flexShrink={0} fg={theme.text.action.secondary.base}>
                      {"  ⇄ "}
                    </text>
                    <box flexGrow={1} minWidth={0}>
                      <text fg={theme.text.base} wrapMode="none" truncate>
                        {room.name}
                        <span style={{ fg: theme.text.muted }}>{` · ${new URL(room.url).host}`}</span>
                      </text>
                    </box>
                    <HoverAction
                      id={`room-leave:${roomKey(room)}`}
                      onMouseEnter={() => setHover(roomKey(room))}
                      onMouseLeave={() => setHover(roomKey(room))}
                      onClick={() => leave(room)}
                    >
                      <text
                        fg={
                          armed() === roomKey(room)
                            ? theme.text.action.destructive.focused
                            : theme.text.action.destructive.base
                        }
                      >
                        {armed() === roomKey(room) ? ` ${t("leave?")}` : " × "}
                      </text>
                    </HoverAction>
                  </Row>
                  <RoomDodRows
                    id={roomKey(room)}
                    hover={hover}
                    setHover={setHover}
                    load={() => roomClient(room).room.guest.dod.get({ roomID: room.roomID })}
                    loadBoard={() => roomClient(room).room.guest.dod.board({ roomID: room.roomID })}
                    take={(id) =>
                      roomClient(room).room.guest.dod.claim(
                        id ? { roomID: room.roomID, id, take: true } : { roomID: room.roomID, next: true, take: true },
                      )
                    }
                    submit={(id) => roomClient(room).room.guest.dod.submit({ roomID: room.roomID, id })}
                    release={(id) => roomClient(room).room.guest.dod.claim({ roomID: room.roomID, id, take: false })}
                    feed={(after, wait) => roomClient(room).room.guest.feed({ roomID: room.roomID, after, wait })}
                  />
                  <RoomSessions
                    room={room}
                    hover={hover}
                    setHover={setHover}
                    current={route.data.type === "room" && sameRoom(route.data, room) ? route.data.sessionID : undefined}
                    onOpen={(sessionID) => openRoom(room, sessionID)}
                  />
                </>
              )}
            </For>
            <Show when={(rooms.latest ?? []).length === 0 && joined.joined.length === 0}>
              <box paddingLeft={1} paddingRight={1}>
                <text fg={theme.text.muted} attributes={TextAttributes.ITALIC} wrapMode="word">
                  {t("No rooms yet. Host a session or connect to someone else's.")}
                </text>
              </box>
            </Show>
          </Section>
          </box>
        </scrollbox>
        {/* In a chat, the room the tree leaves below it shows every Session's hub on the network. */}
        <Show when={route.data.type === "session" && empty.room() >= 5}>
          <box position="absolute" left={0} bottom={0} width="100%" height={empty.room()} paddingLeft={1} paddingRight={1}>
            <AllSessionsField
              currentID={route.data.type === "session" ? route.data.sessionID : undefined}
              backdrop={theme.background.raised.base}
              height={empty.room()}
            />
          </box>
        </Show>
        </box>
        <ClearSessionsAction
          api={client.api.session}
          confirm={confirmClear}
          notify={(options) => toast.show(options)}
          currentSessionID={route.data.type === "session" ? route.data.sessionID : undefined}
          leaveCurrentSession={() => route.navigate({ type: "home" })}
        />
      </box>
    </Show>
  )
}

// A collapsible section of the panel: a rounded card whose border carries the name, so projects
// and multiplayer read as separate blocks. The first line holds the count, the actions and the fold.
function Section(props: {
  title: string
  icon: string
  count?: number
  gap?: boolean
  actions?: JSX.Element
  children: JSX.Element
}) {
  const theme = useTheme()
  const [open, setOpen] = createSignal(true)
  const [hovered, setHovered] = createSignal(false)
  const palette = () => neuralPalette(theme)
  return (
    <box
      flexShrink={0}
      marginTop={props.gap ? 1 : 0}
      marginLeft={1}
      marginRight={1}
      border
      borderStyle="rounded"
      borderColor={hovered() ? tint(theme.border.base, palette().signal, 0.6) : theme.border.base}
      title={` ${props.icon} ${props.title.toLocaleUpperCase()} `}
      titleColor={hovered() ? palette().signal : theme.text.base}
      onMouseOver={() => setHovered(true)}
      onMouseOut={() => setHovered(false)}
    >
      <box flexDirection="row" paddingRight={0} flexShrink={0}>
        <Show when={props.count !== undefined}>
          <box paddingLeft={1} flexShrink={0}>
            <text fg={palette().signal} wrapMode="none">
              {`${props.count}`}
            </text>
          </box>
        </Show>
        <box flexGrow={1} />
        {props.actions}
        <HoverAction id={`section-fold:${props.title}`} paddingLeft={1} paddingRight={1} onClick={() => setOpen(!open())}>
          <text fg={theme.text.muted}>{open() ? "▾" : "▸"}</text>
        </HoverAction>
      </box>
      <Show when={open()}>{props.children}</Show>
    </box>
  )
}

// A small text action on the right of a section heading.
function SectionAction(props: { id: string; label: string; onClick: () => void }) {
  return <NeuralChip id={props.id} label={props.label} accent onClick={props.onClick} />
}

// A pill for the main actions inside a section.
function SectionButton(props: { label: string; icon: string; onClick: () => void }) {
  return <NeuralChip label={props.label} icon={props.icon} accent onClick={props.onClick} />
}

// One half of the segmented switch at the top: the active half is filled, the other lights on hover.
function Tab(props: {
  tab: NotesTab
  icon: string
  label: string
  hover: () => string | undefined
  setHover: (id: string | undefined) => void
}) {
  const theme = useTheme()
  const notes = useNotes()
  const id = `tab:${props.tab}`
  const active = () => notes.tab() === props.tab
  const palette = () => neuralPalette(theme)
  return (
    <box
      id={id}
      flexDirection="row"
      flexShrink={0}
      paddingLeft={1}
      paddingRight={1}
      backgroundColor={
        active() ? theme.background.action.primary.focused : props.hover() === id ? hoverBackground(theme) : undefined
      }
      onMouseOver={() => props.setHover(id)}
      onMouseOut={() => props.setHover(undefined)}
      onMouseDown={(event) => {
        event.stopPropagation()
        notes.setTab(props.tab)
      }}
    >
      {/* On the filled active half the icon takes the label's color, or it vanishes into the fill. */}
      <text
        fg={
          active()
            ? theme.text.action.primary.focused
            : props.hover() === id
              ? theme.text.action.primary.hovered
              : palette().synapse
        }
        wrapMode="none"
      >
        {props.label ? `${props.icon} ` : props.icon}
      </text>
      <text
        fg={
          active()
            ? theme.text.action.primary.focused
            : props.hover() === id
              ? theme.text.base
              : theme.text.muted
        }
        attributes={active() ? TextAttributes.BOLD : undefined}
        wrapMode="none"
      >
        {props.label}
      </text>
    </box>
  )
}

// The Notes tab: the notes of the project of the open session, or of the project
// last picked, or of the first one.
function ProjectNotes() {
  const notes = useNotes()
  const route = useRoute()
  const toast = useToast()
  const projects = useProjects().list
  const now = useNow()
  const project = createMemo(() => projects().find((item) => item.id === notes.project()) ?? projects()[0])
  const directory = () => project()?.directory
  const openName = () => (route.data.type === "session" ? notes.bound(route.data.sessionID)?.name : undefined)
  const fail = (error: unknown) => toast.show({ variant: "error", message: errorMessage(error) })

  return (
    <NotesPanel
      project={project()}
      projects={projects()}
      notes={directory() ? notes.list(directory()!) : []}
      loaded={directory() ? notes.loaded(directory()!) : true}
      error={directory() ? notes.error(directory()!) : undefined}
      openName={openName()}
      now={now()}
      creating={notes.creating()}
      onCreating={notes.setCreating}
      onPickProject={notes.setProject}
      onOpen={(note) => {
        const target = directory()
        if (target) void notes.open(target, note).catch(fail)
      }}
      onCreate={(title) => {
        const target = directory()
        if (target) void notes.start(target, title).catch(fail)
      }}
      onRemove={(note) => {
        const target = directory()
        if (!target) return
        void notes.remove(target, note).catch(fail)
      }}
    />
  )
}

// The sessions of a joined project room, under the room in the left panel, with a row to
// start another. A room sharing one session lists nothing here; the room row opens it.
function RoomSessions(props: {
  room: JoinedRoom
  hover: () => string | undefined
  setHover: (id: string | undefined) => void
  current?: string
  onOpen: (sessionID: string) => void
}) {
  const theme = useTheme()
  const toast = useToast()
  const t = useT()
  const remote = roomClient(props.room)
  const roomID = props.room.roomID
  const [sessions, setSessions] = createSignal<readonly SessionInfo[]>([])
  const [category, setCategory] = createSignal<Readonly<Record<string, string>>>({})
  const [project, setProject] = createSignal(false)
  // A gone host or a removed guest just lists nothing; the room view says why.
  const load = () =>
    void Promise.all([remote.room.guest.get({ roomID }), remote.room.guest.session.list({ roomID })])
      .then(([joined, list]) => {
        setProject(joined.room.directory !== undefined)
        setSessions(list.data)
        setCategory(list.category ?? {})
      })
      .catch(() => setSessions([]))
  // Grouped as the host's tree groups them: categories in first-seen order, then "Other".
  const groups = createMemo(() => {
    const names = [...new Set(sessions().flatMap((session) => category()[session.id] ?? []))]
    const rest = sessions().filter((session) => !category()[session.id])
    return [
      ...names.map((name) => ({ name, sessions: sessions().filter((session) => category()[session.id] === name) })),
      ...(rest.length > 0 ? [{ name: names.length > 0 ? t("Other") : "", sessions: rest }] : []),
    ]
  })
  onMount(() => {
    load()
    const timer = setInterval(load, 5000)
    onCleanup(() => clearInterval(timer))
  })
  const start = () =>
    void remote.room.guest.session
      .create({ roomID })
      .then((created) => {
        setSessions((list) => [created, ...list])
        props.onOpen(created.id)
      })
      .catch((error: unknown) => toast.show({ message: errorMessage(error), variant: "error" }))
  const key = (id: string) => `room:${props.room.url}#${roomID}:${id}`
  return (
    <Show when={project()}>
      <For each={groups()}>
        {(group) => (
          <>
            <Show when={group.name}>
              <box paddingLeft={6}>
                <text fg={theme.text.muted} attributes={TextAttributes.BOLD} wrapMode="none" truncate>
                  {group.name}
                </text>
              </box>
            </Show>
            <For each={group.sessions}>
              {(session) => (
                <Row
                  id={key(session.id)}
                  hover={props.hover}
                  setHover={props.setHover}
                  selected={props.current === session.id}
                  onClick={() => props.onOpen(session.id)}
                >
                  <text flexShrink={0} fg={theme.text.muted}>
                    {"      ○ "}
                  </text>
                  <box flexGrow={1} minWidth={0}>
                    <text fg={theme.text.base} wrapMode="none" truncate>
                      {session.title || t("Untitled")}
                    </text>
                  </box>
                </Row>
              )}
            </For>
          </>
        )}
      </For>
      <Row id={key("new")} hover={props.hover} setHover={props.setHover} onClick={start}>
        <text fg={theme.text.muted}>{"      " + t("+ New session")}</text>
      </Row>
    </Show>
  )
}

// Who is in the rooms this computer hosts, right under the Multiplayer heading: whether
// each guest is connected, the role a click steps through, and removing or banning
// after a second click. Banned guests follow, each with a way back in.
function RoomPeople(props: {
  rooms: readonly RoomInfo[]
  hover: () => string | undefined
  setHover: (id: string | undefined) => void
}) {
  const client = useClient()
  const theme = useTheme()
  const toast = useToast()
  const t = useT()
  const [open, setOpen] = createSignal(true)
  const [members, setMembers] = createSignal<Record<string, readonly RoomMemberView[]>>({})
  const [bans, setBans] = createSignal<Record<string, readonly RoomBan[]>>({})
  const [armed, setArmed] = createSignal<string>()
  // Guests report in every couple of seconds; reading as often keeps "online" honest.
  const read = () =>
    Promise.all(
      props.rooms.map((room) =>
        Promise.all([
          client.api.room.member.list({ roomID: room.id }).catch(() => []),
          client.api.room.ban.list({ roomID: room.id }).catch(() => []),
        ]).then(([listed, banned]) => ({ id: room.id, listed, banned })),
      ),
    ).then((list) => {
      setMembers(Object.fromEntries(list.map((item) => [item.id, item.listed])))
      setBans(Object.fromEntries(list.map((item) => [item.id, item.banned])))
    })
  createEffect(
    on(
      () => props.rooms,
      () => void read(),
    ),
  )
  onMount(() => {
    const timer = setInterval(() => void read(), 3000)
    onCleanup(() => clearInterval(timer))
  })

  const people = () => props.rooms.flatMap((room) => (members()[room.id] ?? []).map((member) => ({ room, member })))
  const banned = () => props.rooms.flatMap((room) => (bans()[room.id] ?? []).map((ban) => ({ room, ban })))
  const named = (name: string, room: RoomInfo) => (props.rooms.length > 1 ? `${name} · ${room.name}` : name)

  const act = (action: () => Promise<unknown>) =>
    void action()
      .then(read)
      .catch((error: unknown) => toast.show({ message: errorMessage(error), variant: "error" }))
  const confirm = (key: string, action: () => Promise<unknown>) => {
    if (armed() !== key) return setArmed(key)
    setArmed()
    act(action)
  }
  const cycle = (room: RoomInfo, member: RoomMemberView) => {
    const role = nextMemberRole(member.role)
    setMembers((all) => ({
      ...all,
      [room.id]: (all[room.id] ?? []).map((item) => (item.id === member.id ? { ...item, role } : item)),
    }))
    act(() => client.api.room.member.update({ roomID: room.id, guestID: member.id, role }))
  }
  const destructive = (key: string) =>
    armed() === key ? theme.text.action.destructive.focused : theme.text.action.destructive.base

  return (
    <Show when={props.rooms.length > 0}>
      <Row id="people" hover={props.hover} setHover={props.setHover} onClick={() => setOpen(!open())}>
        <text fg={theme.text.muted}>{open() ? "  ▾ " : "  ▸ "}</text>
        <box flexGrow={1} minWidth={0}>
          <text fg={theme.text.base} wrapMode="none" truncate>
            {t("Participants")}
          </text>
        </box>
        <text fg={theme.text.muted}>
          {t("{online}/{total} online", {
            online: people().filter((item) => item.member.online).length,
            total: people().length,
          })}
        </text>
      </Row>
      <Show when={open()}>
        <Show
          when={people().length > 0}
          fallback={
            <box paddingLeft={6} paddingRight={1}>
              <text fg={theme.text.muted}>{t("No guests have joined yet.")}</text>
            </box>
          }
        >
          <For each={people()}>
            {(item) => {
              const [roleHovered, setRoleHovered] = createSignal(false)
              const [kickHovered, setKickHovered] = createSignal(false)
              const [banHovered, setBanHovered] = createSignal(false)
              return (
              <box flexDirection="row" paddingLeft={5} paddingRight={1}>
                <text fg={item.member.online ? theme.text.feedback.success.base : theme.text.muted}>
                  {item.member.online ? "● " : "○ "}
                </text>
                <box flexGrow={1} minWidth={0}>
                  <text fg={theme.text.base} wrapMode="none" truncate>
                    {named(item.member.name, item.room)}
                  </text>
                </box>
                <HoverAction
                  id={`member-role:${item.member.id}`}
                  onHoverChange={setRoleHovered}
                  onClick={() => cycle(item.room, item.member)}
                >
                  <text fg={roleHovered() ? theme.text.action.primary.hovered : theme.text.base}>
                    {` [${t(ROLE_LABEL[item.member.role])}]`}
                  </text>
                </HoverAction>
                <HoverAction
                  id={`member-kick:${item.member.id}`}
                  variant="destructive"
                  minWidth={6}
                  justifyContent="flex-end"
                  onHoverChange={setKickHovered}
                  onMouseLeave={() => setArmed()}
                  onClick={() =>
                    confirm(`kick:${item.member.id}`, () =>
                      client.api.room.member.remove({ roomID: item.room.id, guestID: item.member.id }),
                    )
                  }
                >
                  <text
                    fg={
                      kickHovered()
                        ? theme.text.action.destructive.hovered
                        : destructive(`kick:${item.member.id}`)
                    }
                  >
                    {armed() === `kick:${item.member.id}` ? ` ${t("Kick?")}` : " × "}
                  </text>
                </HoverAction>
                <HoverAction
                  id={`member-ban:${item.member.id}`}
                  variant="destructive"
                  minWidth={5}
                  justifyContent="flex-end"
                  onHoverChange={setBanHovered}
                  onMouseLeave={() => setArmed()}
                  onClick={() =>
                    confirm(`ban:${item.member.id}`, () =>
                      client.api.room.member.ban({ roomID: item.room.id, guestID: item.member.id }),
                    )
                  }
                >
                  <text
                    fg={
                      banHovered()
                        ? theme.text.action.destructive.hovered
                        : destructive(`ban:${item.member.id}`)
                    }
                  >
                    {armed() === `ban:${item.member.id}` ? ` ${t("Ban?")}` : ` ${t("ban")}`}
                  </text>
                </HoverAction>
              </box>
              )
            }}
          </For>
        </Show>
        <For each={banned()}>
          {(item) => (
            <box flexDirection="row" paddingLeft={5} paddingRight={1}>
              <text fg={theme.text.action.destructive.base}>{"⊘ "}</text>
              <box flexGrow={1} minWidth={0}>
                <text fg={theme.text.muted} wrapMode="none" truncate>
                  {named(item.ban.name, item.room)}
                </text>
              </box>
              <HoverAction
                id={`member-unban:${item.ban.id}`}
                onClick={() => act(() => client.api.room.ban.remove({ roomID: item.room.id, banID: item.ban.id }))}
              >
                <text fg={theme.text.action.primary.base}>{` ${t("unban")}`}</text>
              </HoverAction>
            </box>
          )}
        </For>
      </Show>
    </Show>
  )
}
