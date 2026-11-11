// bun packages/cli/test/manual/settings-restart.ts; local temp data only, no providers/network.
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { spawn } from "node:child_process"
const root=await mkdtemp(path.join(os.tmpdir(),"orchestra-settings-restart-"))
async function run(file:string,mode:string){await new Promise<void>((resolve,reject)=>{const child=spawn(process.execPath,[file,mode],{env:{...process.env,ORCHESTRA_CONFIG_DIR:path.join(root,"config"),ORCHESTRA_STATE_DIR:path.join(root,"state"),ORCHESTRA_DATA_DIR:path.join(root,"data")},stdio:"inherit"});child.on("exit",code=>code===0?resolve():reject(Error(`${mode}: ${code}`)))})}
try{
 const config=path.join(import.meta.dir,"settings-config-worker.ts"),state=path.resolve(import.meta.dir,"../../../core/test/manual/settings-state-worker.ts")
 await run(config,"write");await run(config,"read");await run(state,"write");await run(state,"read")
 console.log("PASS all settings read in separate restarted processes; pending requests remain UNAPPROVED")
}finally{await rm(root,{recursive:true,force:true})}
