import {expect,test} from "bun:test"
import {mkdtemp,mkdir,writeFile,symlink,rm} from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {ReportPaths} from "../src/report-paths"
test("read-only report code paths are checked without following references outside the project",async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),"report-paths-"))
 try{
  await mkdir(path.join(root,"src"));await writeFile(path.join(root,"src/real.ts"),"hello")
  await symlink(os.tmpdir(),path.join(root,"src/outside.ts"))
  const text='`src/real.ts:12` `src/imagined.ts` `src/outside.ts` `src/../../escape.ts` `https://example.com/file.ts`'
  expect(await ReportPaths.inspect(root,text)).toEqual([{path:"src/real.ts",status:"exists"},{path:"src/imagined.ts",status:"missing"},{path:"src/outside.ts",status:"outside"},{path:"src/../../escape.ts",status:"outside"}])
  expect(ReportPaths.note(await ReportPaths.inspect(root,text))).toContain("not existing code")
 }finally{await rm(root,{recursive:true,force:true})}
})
