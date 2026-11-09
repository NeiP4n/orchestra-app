export * as ProjectFilesBootstrap from "./bootstrap.js"
import {mkdir,writeFile} from "node:fs/promises"
import path from "node:path"
import {Effect} from "effect"
import type {KV} from "../kv.js"
import {ProjectFilesState} from "./files-state.js"
import {ProjectFilesPaths} from "./paths.js"
/** Initialize only project-local state. Never run global society/integration mirrors here.
 * File-owned material is create-only: opening an existing project cannot erase the operator's edits. */
export const initialize=(directory:string,name:string,kv:KV.Interface)=>Effect.gen(function*(){
 const root=ProjectFilesPaths.orchestraDir(directory)
 yield* Effect.tryPromise(()=>mkdir(root,{recursive:true}))
 const create=(file:string,text:string)=>Effect.tryPromise(async()=>{try{await writeFile(path.join(root,file),text,{flag:"wx",mode:0o600})}catch(error){if((error as NodeJS.ErrnoException).code!=="EEXIST")throw error}})
 yield* create("orchestra.json","{}\n")
 yield* create("briefing.md",ProjectFilesState.renderBriefing({title:name,goal:"",status:"draft"}))
 yield* create("handoffs.md","# Handoffs\n")
 yield* create("lifecycle.json",JSON.stringify(ProjectFilesState.newLifecycle(),null,2)+"\n")
 for(const dir of ["sessions","notes","plots","decisions","reports","snapshots"])yield* Effect.tryPromise(()=>mkdir(path.join(root,dir),{recursive:true}))
 yield* ProjectFilesState.syncRules(directory,{kv})
 yield* ProjectFilesState.syncTasks(directory,{kv})
 yield* ProjectFilesState.syncDecisions(directory,{kv})
})
