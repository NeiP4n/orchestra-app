// The Console tab shows one shell per project directory, shared by every session of that project.
// Terminals are stored per session by the server, so the shell of a project is found among the
// terminals of the sessions that share its directory: the open session's own selection wins, then
// the open session's terminals, then those of its siblings in the same directory.
export type ConsoleSession = { id: string; directory: string }

export function consoleTerminalID(input: {
  sessionID: string
  sessions: readonly ConsoleSession[]
  terminals: (sessionID: string) => readonly { id: string }[]
  selected: (sessionID: string) => string | null
}): string | undefined {
  const current = input.sessions.find((session) => session.id === input.sessionID)
  if (!current) return
  const own = input.terminals(input.sessionID)
  const picked = input.selected(input.sessionID)
  if (picked && own.some((terminal) => terminal.id === picked)) return picked
  const ordered = [current, ...input.sessions.filter((s) => s.id !== current.id && s.directory === current.directory)]
  // Every session of a project must land on the same shell, so siblings are ordered by id, not by who is open.
  const siblings = ordered.slice(1).sort((a, b) => a.id.localeCompare(b.id))
  for (const session of [current, ...siblings]) {
    const first = input.terminals(session.id).at(0)
    if (first) return first.id
  }
}

export function consoleSiblings(sessionID: string, sessions: readonly ConsoleSession[]) {
  const current = sessions.find((session) => session.id === sessionID)
  if (!current) return [sessionID]
  return sessions.filter((session) => session.directory === current.directory).map((session) => session.id)
}
