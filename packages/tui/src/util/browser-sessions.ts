// The Browser view keeps any number of browser sessions per project. A session is a name, an optional
// group and, later, its own browser profile directory (the id keys that directory). The state is plain
// data so the panel and the center view read one source and tests can drive it without a terminal.
export type BrowserSession = {
  id: string
  name: string
  group?: string
  created: number
  /** The chat of this session's BrowserAgent. One browser session has one BrowserAgent; it comes back with the session. */
  chat?: string
}

/** A session the user closed. Its id still keys the Chrome profile folder, so reopening it brings the logins back. */
export type ClosedBrowserSession = BrowserSession & { closedAt: number }

export type BrowserSessionsState = {
  /** BrowserAgent chats explicitly removed/closed, including evicted history. Never auto-adopt them. */
  retiredChats?: Record<string, string[]>
  projects: Record<string, BrowserSession[]>
  selected: Record<string, string | undefined>
  /** Closed sessions per project, newest first. Missing in state saved by older versions. */
  closed?: Record<string, ClosedBrowserSession[]>
}

export const MAX_CLOSED_BROWSER_SESSIONS = 30

export const emptyBrowserSessions = (): BrowserSessionsState => ({ projects: {}, selected: {} })

export const MAX_BROWSER_SESSIONS = 20

/** Adds a session to a project and selects it. Returns it, or undefined at the limit. */
export function addBrowserSession(
  state: BrowserSessionsState,
  projectID: string,
  input: { id: string; now: number; name?: string; group?: string },
): BrowserSession | undefined {
  const list = (state.projects[projectID] ??= [])
  if (list.length >= MAX_BROWSER_SESSIONS) return undefined
  // The next free number, so removing a middle session never makes two share a name.
  const taken = new Set(list.map((item) => item.name))
  let n = list.length + 1
  while (taken.has(`Browser ${n}`)) n += 1
  const session: BrowserSession = {
    id: input.id,
    name: input.name?.trim() || `Browser ${n}`,
    ...(input.group ? { group: input.group } : {}),
    created: input.now,
  }
  list.push(session)
  state.selected[projectID] = session.id
  return session
}

export function removeBrowserSession(state: BrowserSessionsState, projectID: string, id: string) {
  const list = state.projects[projectID]
  if (!list) return
  const index = list.findIndex((item) => item.id === id)
  if (index < 0) return
  const [gone] = list.splice(index, 1)
  if (gone?.chat) {
    state.retiredChats ??= {}
    state.retiredChats[projectID] = [...new Set([...(state.retiredChats[projectID] ?? []), gone.chat])]
  }
  // Kept aside, not forgotten: the name, group and profile id come back when the user reopens it.
  state.closed ??= {}
  const kept = (state.closed[projectID] ??= []).filter((item) => item.id !== id)
  state.closed[projectID] = [{ ...gone!, closedAt: Date.now() }, ...kept].slice(0, MAX_CLOSED_BROWSER_SESSIONS)
  if (state.selected[projectID] === id) state.selected[projectID] = list[Math.max(0, index - 1)]?.id
}

/**
 * Brings a closed session back with its own id (so the same Chrome profile) and its own name, whatever other
 * sessions are called now. Returns it, or undefined when it is not closed or the project is at the limit.
 */
export function reopenBrowserSession(state: BrowserSessionsState, projectID: string, id: string) {
  const closed = state.closed?.[projectID]
  const found = closed?.find((item) => item.id === id)
  if (!closed || !found) return undefined
  const list = (state.projects[projectID] ??= [])
  if (list.length >= MAX_BROWSER_SESSIONS) return undefined
  const session: BrowserSession = {
    id: found.id,
    name: found.name,
    ...(found.group ? { group: found.group } : {}),
    ...(found.chat ? { chat: found.chat } : {}),
    created: found.created,
  }
  list.push(session)
  state.closed![projectID] = closed.filter((item) => item.id !== id)
  state.selected[projectID] = session.id
  return session
}

/** Drops a closed session from the list for good. Its profile folder is not touched here. */
export function forgetClosedBrowserSession(state: BrowserSessionsState, projectID: string, id: string) {
  const closed = state.closed?.[projectID]
  const removed = closed?.find((item) => item.id === id)
  if (removed?.chat) {
    state.retiredChats ??= {}
    state.retiredChats[projectID] = [...new Set([...(state.retiredChats[projectID] ?? []), removed.chat])]
  }
  if (closed) state.closed![projectID] = closed.filter((item) => item.id !== id)
}

/** Changes only the label. The id, which keys the Chrome profile folder, is never touched, so logins stay. */
export function renameBrowserSession(state: BrowserSessionsState, projectID: string, id: string, name: string) {
  const item = state.projects[projectID]?.find((entry) => entry.id === id)
  const next = name.trim().slice(0, 60)
  if (!item || !next) return false
  item.name = next
  return true
}

/** Binds the BrowserAgent chat to a session. A session keeps the first chat it got: one session, one BrowserAgent. */
export function bindBrowserChat(state: BrowserSessionsState, projectID: string, id: string, chat: string) {
  const item = state.projects[projectID]?.find((entry) => entry.id === id)
  if (!item || item.chat) return false
  item.chat = chat
  return true
}

/**
 * Makes a record for a browser chat nobody owns (the Orchestrator created it): its own id, so its own Chrome
 * profile, named like the chat and holding it. The selection stays where it was. Returns it, or undefined when
 * the chat is already owned (open or closed) or the project is at the limit.
 */
export function adoptBrowserChat(
  state: BrowserSessionsState,
  projectID: string,
  input: { id: string; chat: string; name: string; now: number },
): BrowserSession | undefined {
  if (state.retiredChats?.[projectID]?.includes(input.chat)) return undefined
  const owned = [...(state.projects[projectID] ?? []), ...(state.closed?.[projectID] ?? [])].some((item) => item.chat === input.chat)
  if (owned) return undefined
  // A restart finds the chat the last run made for a record whose bind did not reach the disk: the record with this
  // name and no chat takes it. A record of this name that already has its own chat means this one is a stray copy.
  const sameName = [...(state.projects[projectID] ?? []), ...(state.closed?.[projectID] ?? [])].filter(
    (item) => item.name.trim().toLowerCase() === input.name.trim().toLowerCase(),
  )
  const chatless = sameName.find((item) => !item.chat)
  if (chatless) {
    chatless.chat = input.chat
    return chatless
  }
  if (sameName.length > 0) return undefined
  const selected = state.selected[projectID]
  const session = addBrowserSession(state, projectID, { id: input.id, now: input.now, name: input.name })
  if (!session) return undefined
  session.chat = input.chat
  state.selected[projectID] = selected
  return session
}

/**
 * One chat belongs to one browser session. When several records point at the same chat (an adopted copy made while
 * the button's record was still being given its chat), the oldest stays and the others go, with the selection moved
 * to the survivor. They are dropped, not kept closed: they never had a page or a chat of their own. Returns the number removed.
 */
export function collapseDuplicateChats(state: BrowserSessionsState): number {
  let removed = 0
  for (const [projectID, list] of Object.entries(state.projects ?? {})) {
    const keeper = new Map<string, BrowserSession>()
    for (const item of [...list].sort((a, b) => a.created - b.created)) {
      if (!item.chat) continue
      if (!keeper.has(item.chat)) keeper.set(item.chat, item)
    }
    const drop = list.filter((item) => item.chat && keeper.get(item.chat) !== item)
    // A record with no chat (never had a page or a BrowserAgent) beside an older one of the same name is an empty copy.
    const named = new Map<string, BrowserSession>()
    for (const item of [...list].sort((a, b) => a.created - b.created)) {
      if (drop.includes(item)) continue
      const key = item.name.trim().toLowerCase()
      const first = named.get(key)
      if (!first) named.set(key, item)
      else if (!item.chat) drop.push(item)
      else if (!first.chat) {
        drop.push(first)
        named.set(key, item)
      }
    }
    if (drop.length === 0) continue
    for (const item of drop) {
      list.splice(list.indexOf(item), 1)
      if (state.selected[projectID] === item.id) {
        const heir = (item.chat && keeper.get(item.chat)) || named.get(item.name.trim().toLowerCase()) || list[0]
        state.selected[projectID] = heir?.id
      }
      removed += 1
    }
  }
  return removed
}

export function selectBrowserSession(state: BrowserSessionsState, projectID: string, id: string) {
  if (state.projects[projectID]?.some((item) => item.id === id)) state.selected[projectID] = id
}

export function groupBrowserSession(state: BrowserSessionsState, projectID: string, id: string, group?: string) {
  const item = state.projects[projectID]?.find((entry) => entry.id === id)
  if (!item) return
  if (group?.trim()) item.group = group.trim()
  else delete item.group
}

/** The project's sessions grouped for display: ungrouped first, then each group in first-seen order. */
export function browserSessionGroups(list: readonly BrowserSession[]) {
  const names = [...new Set(list.flatMap((item) => (item.group ? [item.group] : [])))]
  return [
    { name: undefined as string | undefined, sessions: list.filter((item) => !item.group) },
    ...names.map((name) => ({ name, sessions: list.filter((item) => item.group === name) })),
  ].filter((group) => group.sessions.length > 0)
}

/** A deleted chat leaves its browser session (open or closed) without a BrowserAgent: the next open gives it a new one. */
export function forgetBrowserChat(state: BrowserSessionsState, chat: string) {
  for (const item of Object.values(state.projects).flat()) if (item.chat === chat) delete item.chat
  for (const item of Object.values(state.closed ?? {}).flat()) if (item.chat === chat) delete item.chat
}

/** BrowserAgent chats the user opened from the Projects tab: the view stays on Projects for them. */
export const openedFromProjects = new Set<string>()
