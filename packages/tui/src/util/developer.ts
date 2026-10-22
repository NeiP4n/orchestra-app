// Commands that only help while building or debugging Orchestra itself. They stay registered, so
// their key bindings and typed slash names keep working, but the command palette and the slash
// menu list them only in developer mode.
export const DEVELOPER_COMMANDS: ReadonlySet<string> = new Set([
  "app.debug",
  "app.console",
  "opencode.debug",
  "service.restart",
  "location.reload",
  "server.pair",
  "terminal.suspend",
  "terminal.title.toggle",
  "app.toggle.file_context",
  "app.toggle.paste_summary",
  "app.toggle.diffwrap",
  "model.cycle_recent_reverse",
  "model.cycle_favorite_reverse",
  "agent.cycle.reverse",
  "session.line.up",
  "session.line.down",
  "session.half.page.up",
  "session.half.page.down",
  "session.page.up",
  "session.page.down",
  "session.toggle.scrollbar",
  "theme.mode.lock",
])

export function listedCommand(id: string | undefined, developer: boolean | undefined) {
  if (developer) return true
  return id === undefined || !DEVELOPER_COMMANDS.has(id) && !id.startsWith("storybook")
}
