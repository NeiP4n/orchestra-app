export * as SafetyConfig from "./safety-config.js"
import fs from "node:fs"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { Path } from "@orchestra/util/global"
export interface Info { version:1; drainMs?:number; drainTokens?:number; browserMax?:number|null; localTest?:boolean; disabled?:boolean; acknowledgedAt?:number }
const file=()=>path.join(Path.state,"operator-safety.json")
export function read():Info{
 try{
  const value=JSON.parse(fs.readFileSync(file(),"utf8")) as Info
  if(value?.version!==1)throw Error()
  for(const key of ["drainMs","drainTokens"] as const)if(value[key]!==undefined&&(!Number.isSafeInteger(value[key])||value[key]!<1))throw Error()
  if(value.browserMax!==undefined&&value.browserMax!==null&&(!Number.isSafeInteger(value.browserMax)||value.browserMax<1))throw Error()
  if(value.localTest!==undefined&&typeof value.localTest!=="boolean")throw Error()
  // A bare disabled:true edit is not a completed operator acknowledgement.
  if(value.disabled&&(!Number.isFinite(value.acknowledgedAt)||value.acknowledgedAt!<=0))return {...value,disabled:false,acknowledgedAt:undefined}
  return value
 }catch{return {version:1}}
}
/** Operator UI only. Models receive no settings mutation tool. Every expansion is reviewed by UI. */
export function write(next:Info,confirmation?:string):void{
 if(next.version!==1)throw Error("Invalid safety config version")
 for(const key of ["drainMs","drainTokens"] as const)if(next[key]!==undefined&&(!Number.isSafeInteger(next[key])||next[key]!<1))throw Error("Invalid positive safety limit")
 if(next.browserMax!==undefined&&next.browserMax!==null&&(!Number.isSafeInteger(next.browserMax)||next.browserMax<1))throw Error("Invalid browser max")
 if(next.localTest!==undefined&&typeof next.localTest!=="boolean")throw Error("Invalid local test flag")
 const before=read()
 const expanded=(next.disabled&&!before.disabled)||(!before.localTest&&next.localTest)||((next.browserMax===null?Infinity:next.browserMax??Infinity)>(before.browserMax===null?Infinity:before.browserMax??Infinity))||(next.drainMs??14_400_000)>(before.drainMs??14_400_000)||(next.drainTokens??10_000_000)>(before.drainTokens??10_000_000)
 if(expanded&&confirmation!=="РАЗРЕШИТЬ")throw Error("Расширение защиты требует РАЗРЕШИТЬ")
 const value={...next,version:1 as const,...(next.disabled?{acknowledgedAt:before.disabled?before.acknowledgedAt:Date.now()}:{disabled:false,acknowledgedAt:undefined})}
 fs.mkdirSync(path.dirname(file()),{recursive:true,mode:0o700});const temp=file()+"."+randomUUID()+".tmp",fd=fs.openSync(temp,"wx",0o600)
 try{fs.writeFileSync(fd,JSON.stringify(value));fs.fsyncSync(fd)}finally{fs.closeSync(fd)}
 fs.renameSync(temp,file())
}
export const disabled=()=>{const value=read();return value.disabled===true&&typeof value.acknowledgedAt==="number"}
/** Restores limits in one action, preserving numeric caps. Does not change money/Vault/publishing. */
export function restore():void{write({...read(),version:1,disabled:false,localTest:false})}
