/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { ProjectsProvider, useProjects } from "../src/context/projects"
import { renderLocal, session } from "./fixture/local"
import { directory, json } from "./fixture/tui-client"

test("an idle project count refreshes on a committed external change, not only an early session-created event", async () => {
  let projects = [{ id: "prj_first", name: "First", directory, main: "ses_first", created: 1 }]
  let reads = 0
  function Count() {
    const list = useProjects()
    return <text>{list.loaded() ? `${list.list().length} projects` : "loading"}</text>
  }
  await using app = await renderLocal({
    fetch: async url => {
      if(url.pathname === "/api/orchestra/project") { reads++; return json(projects) }
      if(url.pathname === "/api/session/ses_external") return json({data:session("ses_external")})
      if(url.pathname === "/api/orchestra/owner") return json({})
    },
    view: () => <ProjectsProvider><Count /></ProjectsProvider>,
  })
  app.renderer.start()
  await app.waitForFrame(frame => frame.includes("1 projects"))
  const before = reads
  // The new main session can be broadcast while its template project is still
  // private. The old count from that request is correct, but not final.
  app.events.emit({id:"evt_early",type:"session.created",data:{sessionID:"ses_external"}} as never)
  await app.waitFor(() => reads > before)
  await app.renderOnce()
  expect(app.captureCharFrame()).toContain("1 projects")
  projects = [...projects,{ id:"prj_external",name:"External",directory,main:"ses_external",created:2 }]
  app.events.emit({id:"evt_commit",type:"orchestra.projects.changed",data:{}} as never)
  await app.waitForFrame(frame => frame.includes("2 projects"))
  if(process.env.CAPTURE_PROJECT_COUNT) await Bun.write(process.env.CAPTURE_PROJECT_COUNT,JSON.stringify(app.captureSpans()))
})

test("home status receives the other client's committed project count without Esc or reopening", async () => {
  const { createAppFixture } = await import("./fixture/app")
  let rows = [{id:"prj_first",name:"First",directory,main:"ses_first",created:1}]
  await using app = await createAppFixture({width:130,height:40,config:{animations:false},fetch:async url=>{
    if(url.pathname==="/api/orchestra/project") return json(rows)
    if(url.pathname==="/api/orchestra/owner") return json({})
    if(url.pathname==="/api/orchestra/group") return json([])
  }})
  await app.ready
  await app.waitForFrame(frame=>frame.includes("1 projects"))
  rows=[...rows,{id:"prj_second",name:"Second",directory,main:"ses_second",created:2}]
  app.events.emit({id:"evt_commit_home",type:"orchestra.projects.changed",data:{}} as never)
  const final = await app.waitForFrame(frame=>frame.includes("2 projects"))
  expect(final).toContain("Second")
  expect(final).toContain("2 projects")
  if(process.env.CAPTURE_HOME_COUNT) await Bun.write(process.env.CAPTURE_HOME_COUNT,JSON.stringify(app.captureSpans()))
})
