import { expect, test } from "bun:test"
import { BrowserBridge as B } from "../src/browser/bridge"
import { readFileSync } from "node:fs"
const list=[{id:"brw_a",name:"same",project:"/work/a",projectID:"p_a",chat:"ses_a"},{id:"brw_b",name:"same",project:"/work/b",projectID:"p_b",chat:"ses_b"},{id:"brw_c",name:"nested",project:"/work/a/nested",projectID:"p_c"},{id:"brw_d",name:"same folder other id",project:"/work/a",projectID:"p_d"}]
test("two projects are isolated by stable ID and directory for id/name/visible reads",()=>{
 expect(B.resolve(list,"brw_a","/work/a/src","p_a")).toEqual({session:list[0]})
 for(const id of ["brw_b","brw_c","brw_d"])expect(B.resolve(list,id,"/work/a","p_a")).toHaveProperty("error")
 expect(B.visible(list,"/work/a","p_a").map(i=>i.id)).toEqual(["brw_a"])
 expect(B.visible(list,"/work")).toEqual([]);expect(B.visible(list,"/work/a")).toEqual([])
 expect(B.resolve(list,"same","/work/a","p_a")).toEqual({session:list[0]})
 expect(B.resolve(list,"brw_a","/other","p_a")).toHaveProperty("error")
 expect(B.resolve(list,"brw_a","/work/a/../b","p_a")).toHaveProperty("error")
 expect(B.resolve(list,"brw_a","/WORK/a","p_a")).toHaveProperty("error")
 expect(B.parseSessions(JSON.stringify(list))).toEqual(list)
})
test("legacy registry never crosses directories or inherits child-project browsers",()=>{
 const legacy=list.map(({projectID,...rest})=>rest)
 expect(B.resolve(legacy,"brw_b","/work/a")).toHaveProperty("error")
 expect(B.resolve(legacy,"brw_a","/work/a","p_a")).toHaveProperty("error")
 expect(B.selectedFor({"/work/a":"brw_a"},"/work")).toBeUndefined()
 expect(B.visible(legacy,"/work")).toEqual([])
})
test("model list filters before peek; every action/retry and trigger resume validates owner",()=>{
 const source=readFileSync(new URL("../src/tool/plugin/browser.ts",import.meta.url),"utf8")
 const start=source.indexOf('if (input.action === "sessions")'),end=source.indexOf('// Hard layer',start),body=source.slice(start,end)
 expect(body.indexOf('BrowserBridge.visible')).toBeLessThan(body.indexOf('BrowserRuntime.peek'))
 expect(source).toContain('BrowserBridge.ownerRefusal(BrowserRuntime.sessions(),sessionID,scope.directory,scope.projectID)')
 expect(source).toContain('if(ownerRefusal)return yield* fail(ownerRefusal)')
 expect(source).not.toContain('published.length === 1')
 const trigger=readFileSync(new URL("../src/tool/plugin/triggers.ts",import.meta.url),"utf8")
 expect(trigger).toContain('BrowserBridge.ownerRefusal(BrowserRuntime.sessions(),browserTarget,project.directory,String(project.id))')
})

test("browser context never falls back to a foreign list, and preserves owner binding",()=>{
 const source=readFileSync(new URL("../src/browser/instructions.ts",import.meta.url),"utf8")
 expect(source).toContain('return mine.map(')
 expect(source).not.toContain('mine : all')
 expect(source).toContain('BrowserBridge.visible(all, directory, projectID)')
})
