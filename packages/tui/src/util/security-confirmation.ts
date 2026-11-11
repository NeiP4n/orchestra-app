import fs from "node:fs"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { Global } from "@orchestra/util/global"
export type Approval = { id:string; kind:"permissions"|"hour"|"day"|"safety"; sessionID?:string; triggerID?:string; before:string|number|null; next:string|number|null; createdAt:number }
const directory=()=>path.join(Global.Path.state,"security-confirmations")
function valid(value:Approval):boolean{
 if(!value||typeof value.id!=="string"||!/^[a-f0-9-]{36}$/.test(value.id)||!Number.isFinite(value.createdAt)||value.createdAt<Date.now()-7*86400_000)return false
 if(value.kind==="safety")return typeof value.before==="string"&&typeof value.next==="string"&&value.before.length<2048&&value.next.length<2048
 if(value.kind==="permissions")return value.before==="prompt"&&value.next==="autoaccept"
 if(!["hour","day"].includes(value.kind)||typeof value.sessionID!=="string"||typeof value.triggerID!=="string")return false
 const cap=(n:unknown)=>typeof n==="number"&&Number.isInteger(n)&&n>=1&&n<=(value.kind==="day"?100:10000)
 return (cap(value.before)||(value.kind==="hour"&&value.before===null))&&(cap(value.next)||(value.kind==="hour"&&value.next===null))
}
export function saveApproval(value:Omit<Approval,"id"|"createdAt">):Approval{
 const request={...value,id:randomUUID(),createdAt:Date.now()};if(!valid(request))throw Error("Invalid safety confirmation request")
 fs.mkdirSync(directory(),{recursive:true,mode:0o700});const file=path.join(directory(),request.id+".json"),temp=file+".tmp";fs.writeFileSync(temp,JSON.stringify(request),{mode:0o600});fs.renameSync(temp,file);return request
}
export function pendingApprovals():Approval[]{try{return fs.readdirSync(directory()).filter(name=>/^[a-f0-9-]{36}\.json$/.test(name)).flatMap(name=>{try{const value=JSON.parse(fs.readFileSync(path.join(directory(),name),"utf8"));return valid(value)?[value]:[]}catch{return[]}})}catch{return[]}}
export function removeApproval(id:string){if(!/^[a-f0-9-]{36}$/.test(id))throw Error("Invalid confirmation id");fs.rmSync(path.join(directory(),id+".json"),{force:true})}
