// The Browser view keeps any number of browser sessions per project. A session is a name, an optional
// group and, later, its own browser profile directory (the id keys that directory). The state is plain
// data so the panel and the center view read one source and tests can drive it without a terminal.
export type BrowserSession = { id: string; name: string; group?: string; created: number }

export type BrowserSessionsState = {
  projects: Record<string, BrowserSession[]>
  selected: Record<string, string | undefined>
}

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
  list.splice(index, 1)
  if (state.selected[projectID] === id) state.selected[projectID] = list[Math.max(0, index - 1)]?.id
}

/** Changes only the label. The id, which keys the Chrome profile folder, is never touched, so logins stay. */
export function renameBrowserSession(state: BrowserSessionsState, projectID: string, id: string, name: string) {
  const item = state.projects[projectID]?.find((entry) => entry.id === id)
  const next = name.trim().slice(0, 60)
  if (!item || !next) return false
  item.name = next
  return true
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
