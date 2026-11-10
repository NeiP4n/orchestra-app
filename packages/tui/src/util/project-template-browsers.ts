import type { BrowserSessionsState } from "./browser-sessions"

export interface ImportedBrowsers {
  importID: string
  projectID: string
  createdAt: number
  browsers: readonly { id: string; name: string; chat?: string; mode: "headless" | "window" | "capture" }[]
}
/** Runs only inside Storage.update's locked disk mutation. No BrowserRuntime/agent call,
 * no selected browser, no orphan adoption, no reset of a project the user has already used. */
export function ensureImportedBrowsers(state: BrowserSessionsState, input: ImportedBrowsers) {
  if (
    !/^pti_[A-Za-z0-9_-]{1,100}$/.test(input.importID) ||
    !/^prj[A-Za-z0-9_-]+$/.test(input.projectID) ||
    !Number.isFinite(input.createdAt) ||
    input.browsers.length > 50 ||
    new Set(input.browsers.map((row) => row.id)).size !== input.browsers.length ||
    new Set(input.browsers.flatMap((row) => (row.chat ? [row.chat] : []))).size !==
      input.browsers.filter((row) => row.chat).length ||
    input.browsers.some(
      (row) =>
        !/^brw_[A-Za-z0-9_-]{1,100}$/.test(row.id) ||
        !row.name.trim() ||
        row.name.length > 160 ||
        !["headless", "window", "capture"].includes(row.mode) ||
        (row.chat && !/^ses[A-Za-z0-9_-]{1,120}$/.test(row.chat)),
    )
  )
    throw Error("Invalid imported browser definition.")
  const previous = state.templateImports?.[input.projectID]
  if (previous !== undefined) {
    if (previous !== input.importID) throw Error("Project browser definitions belong to another import.")
    return
  }
  if (
    state.projects?.[input.projectID]?.length ||
    state.closed?.[input.projectID]?.length ||
    state.retiredChats?.[input.projectID]?.length
  )
    throw Error("Cannot replace existing project browser definitions.")
  const existing = [...Object.values(state.projects ?? {}).flat(), ...Object.values(state.closed ?? {}).flat()]
  if (
    input.browsers.some(
      (row) =>
        existing.some((item) => item.id === row.id || (row.chat && item.chat === row.chat)) ||
        Object.values(state.retiredChats ?? {})
          .flat()
          .includes(row.chat ?? ""),
    )
  )
    throw Error("Browser or BrowserAgent identity is already owned.")
  const rows = input.browsers.map((row) => ({
    id: row.id,
    name: row.name,
    created: input.createdAt,
    ...(row.chat ? { chat: row.chat } : {}),
    mode: row.mode,
    templateImportID: input.importID,
  }))
  state.projects ??= {}
  state.projects[input.projectID] = rows
  state.templateImports ??= {}
  state.templateImports[input.projectID] = input.importID
  // Do not select or open a browser. The operator's first explicit browser choice starts it.
}
