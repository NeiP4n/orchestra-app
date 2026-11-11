/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { ProjectsProvider } from "../src/context/projects"
import { NotesProvider, useNotes } from "../src/context/notes"
import { renderLocal, session } from "./fixture/local"
import { directory, json } from "./fixture/tui-client"

for (const mode of ["missing", "offline", "foreign", "child", "valid"] as const)
 test(`connected Browser 2 stale binding recovery and delete: ${mode}`,async()=>{
  let notes!:ReturnType<typeof useNotes>,creates=0,deletes=0,switches=0
  const owners:Record<string,string>={ses_old:mode==="foreign"?"prj_test3":"prj_test2"}
  const live=new Map<string,ReturnType<typeof session>>()
  if(mode!=="missing")live.set("ses_old",{...session("ses_old"),...(mode==="child"?{parentID:"ses_parent"}:{})})
  await using app=await renderLocal({
   fetch:async(url,request)=>{
    if(url.pathname==="/api/orchestra/project")return json([{id:"prj_test2",name:"Test2",directory}])
    if(url.pathname==="/api/orchestra/owner")return json(owners)
    if(url.pathname.startsWith("/api/orchestra/owner/")){owners[url.pathname.split("/").at(-1)!]="prj_test2";return new Response(null,{status:204})}
    if(url.pathname.endsWith("/browsers"))return json(null)
    if(url.pathname==="/api/session"&&request.method==="POST"){
     const body=await request.json();creates++;const next={...session(body.id),agent:body.agent,title:body.title};live.set(body.id,next);owners[body.id]="prj_test2";return json({data:next})
    }
    if(url.pathname.startsWith("/api/session/")){
     const id=url.pathname.split("/")[3]
     if(id==="ses_old"&&mode==="offline")return json({_tag:"UnknownError",message:"offline"},{status:500})
     if(!live.has(id))return json({_tag:"SessionNotFoundError",sessionID:id,message:"Session not found"},{status:404})
     if(request.method==="DELETE"){deletes++;live.delete(id);return new Response(null,{status:204})}
     if(url.pathname.endsWith("/agent")){switches++;return new Response(null,{status:204})}
     return json({data:live.get(id)})
    }
    return undefined
   },
   view:()=> <ProjectsProvider><NotesProvider><Probe/></NotesProvider></ProjectsProvider>,
  })
  function Probe(){notes=useNotes();return <box/>}
  await notes.importBrowserDefinitions({importID:"pti_stale",projectID:"prj_test2",createdAt:1,browsers:[{id:"brw_second",name:"Browser 2",chat:"ses_old",mode:"window"}]})
  if(mode==="offline"||mode==="foreign"||mode==="child"){
   await expect(notes.ensureBrowserAgent("prj_test2","brw_second",directory)).rejects.toBeDefined()
   await expect(notes.removeBoundBrowserChat("prj_test2","ses_old")).rejects.toBeDefined()
   expect(notes.browserSessions("prj_test2")[0].chat).toBe("ses_old")
   expect(creates).toBe(0);expect(deletes).toBe(0);expect(switches).toBe(0)
   return
  }
  if(mode==="missing"){
   await notes.removeBoundBrowserChat("prj_test2","ses_old")
   expect(deletes).toBe(0)
   const recovered=await notes.ensureBrowserAgent("prj_test2","brw_second",directory)
   expect(recovered).toBeDefined();expect(recovered).not.toBe("ses_old");expect(creates).toBe(1)
   expect(notes.browserSessions("prj_test2")[0]).toMatchObject({id:"brw_second",name:"Browser 2",chat:recovered})
   expect(switches).toBe(0)
   await notes.removeBoundBrowserChat("prj_test2",recovered!)
  }else{
   expect(await notes.ensureBrowserAgent("prj_test2","brw_second",directory)).toBe("ses_old")
   await notes.removeBoundBrowserChat("prj_test2","ses_old")
   expect(creates).toBe(0)
  }
  await notes.removeBrowserSession("prj_test2","brw_second")
  expect(notes.browserSessions("prj_test2")).toEqual([])
  expect(notes.closedBrowserSessions("prj_test2")[0]).toMatchObject({id:"brw_second",name:"Browser 2"})
  expect(deletes).toBe(1)
 })
