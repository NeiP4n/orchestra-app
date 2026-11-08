export * as BrowserTabs from "./tabs.js"

// The tabs of one Chrome, read and changed through its DevTools HTTP endpoints. Each tab is a page target
// with its own websocket, so the runtime drives one tab at a time and switches by reconnecting.

export interface Tab {
  readonly id: string
  readonly title: string
  readonly url: string
  readonly wsUrl: string
}

type Fetch = typeof fetch
type Target = { id?: string; type?: string; title?: string; url?: string; webSocketDebuggerUrl?: string }

/** Real pages only: not the DevTools window, extensions, workers or service workers. */
export function parse(targets: ReadonlyArray<Target>): Tab[] {
  return targets
    .filter(
      (item) => item.type === "page" && item.id && item.webSocketDebuggerUrl && !item.url?.startsWith("devtools://"),
    )
    .map((item) => ({ id: item.id!, title: item.title ?? "", url: item.url ?? "", wsUrl: item.webSocketDebuggerUrl! }))
}

const base = (port: number) => `http://127.0.0.1:${port}`

export async function list(port: number, f: Fetch = fetch): Promise<Tab[]> {
  return parse((await (await f(`${base(port)}/json/list`)).json()) as Target[])
}

/** Opens a tab (about:blank by default) and returns it. */
export async function create(port: number, url = "about:blank", f: Fetch = fetch): Promise<Tab> {
  const response = await f(`${base(port)}/json/new?${encodeURIComponent(url)}`, { method: "PUT" })
  const [tab] = parse([(await response.json()) as Target])
  if (!tab) throw new Error("Chrome did not open a new tab.")
  return tab
}

export async function close(port: number, id: string, f: Fetch = fetch) {
  await f(`${base(port)}/json/close/${encodeURIComponent(id)}`)
}

export async function activate(port: number, id: string, f: Fetch = fetch) {
  await f(`${base(port)}/json/activate/${encodeURIComponent(id)}`)
}

/** The tab to show after `closedID` goes away: its right neighbour, else the left one. */
export function neighbour(tabs: ReadonlyArray<Tab>, closedID: string): Tab | undefined {
  const index = tabs.findIndex((tab) => tab.id === closedID)
  const rest = tabs.filter((tab) => tab.id !== closedID)
  return rest[Math.min(Math.max(index, 0), rest.length - 1)]
}
