/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { BrowserRuntime } from "@orchestra/core/browser/runtime"
import { ProjectsProvider } from "../src/context/projects"
import { NotesProvider, useNotes } from "../src/context/notes"
import { renderLocal, session } from "./fixture/local"
import { directory, json } from "./fixture/tui-client"

test("live browser chat delete on home publishes empty disk without a mounted SessionFrame or another action", async () => {
  let notes!: ReturnType<typeof useNotes>
  let live = true
  await using app = await renderLocal({
    fetch: async (url, request) => {
      if(url.pathname === "/api/orchestra/project") return json([{id:"prj_projection",name:"Projection",directory}])
      if(url.pathname === "/api/orchestra/owner") return json({ses_projection:"prj_projection"})
      if(url.pathname.endsWith("/browsers")) return json(null)
      if(url.pathname === "/api/session/ses_projection") {
        if(!live) return json({_tag:"SessionNotFoundError",sessionID:"ses_projection",message:"Session not found"},{status:404})
        if(request.method === "DELETE") { live = false; return new Response(null,{status:204}) }
        return json({data:{...session("ses_projection"),agent:"team-browser-agent"}})
      }
      return undefined
    },
    view: () => <ProjectsProvider><NotesProvider><Probe/></NotesProvider></ProjectsProvider>,
  })
  function Probe(){notes=useNotes();return <box/>}
  await notes.importBrowserDefinitions({importID:"pti_projection",projectID:"prj_projection",createdAt:1,browsers:[{id:"brw_projection",name:"Browser 1",chat:"ses_projection",mode:"window"}]})
  const disk = () => JSON.parse(readFileSync(BrowserRuntime.sessionsFilePath(), "utf8"))
  await waitUntil(() => disk().some((row: { id: string }) => row.id === "brw_projection"))
  expect(disk()).toEqual([expect.objectContaining({id:"brw_projection",chat:"ses_projection"})])
  await notes.removeBoundBrowserChat("prj_projection", "ses_projection")
  await notes.retireDeletedBrowserChat("ses_projection")
  await notes.removeBrowserSession("prj_projection", "brw_projection")
  expect(live).toBe(false)
  expect(notes.browserSessions("prj_projection")).toEqual([])
  await waitUntil(() => disk().length === 0)
  expect(disk()).toEqual([])
  await Bun.sleep(30)
  expect(disk()).toEqual([])
  expect(notes.closedBrowserSessions("prj_projection")[0]).toMatchObject({id:"brw_projection"})
})


async function waitUntil(check: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (check()) return
    await Bun.sleep(10)
  }
  throw Error("Browser projection did not settle")
}

test("owning provider does not erase the previous disk roster while projects are still loading", async () => {
  BrowserRuntime.publishSessions([{id:"brw_previous",name:"Previous",project:directory,projectID:"prj_old"}], {authoritative:true})
  let resolve!: () => void
  const pending = new Promise<void>(done => {resolve=done})
  await using app = await renderLocal({
    fetch: async url => {
      if(url.pathname === "/api/orchestra/project") { await pending; return json([]) }
      if(url.pathname === "/api/orchestra/owner") return json({})
      return undefined
    },
    view: () => <ProjectsProvider><NotesProvider><box/></NotesProvider></ProjectsProvider>,
  })
  expect(JSON.parse(readFileSync(BrowserRuntime.sessionsFilePath(),"utf8"))[0].id).toBe("brw_previous")
  resolve()
  await waitUntil(() => readFileSync(BrowserRuntime.sessionsFilePath(),"utf8") === "[]")
})
