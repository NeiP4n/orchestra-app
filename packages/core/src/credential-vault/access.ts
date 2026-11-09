export * as VaultAccess from "./access.js"
import fs from "node:fs"
import path from "node:path"
import {createHash,randomUUID} from "node:crypto"
import {Path} from "@orchestra/util/global"
export interface Scope {sessionID:string;projectID:string;directory:string}
const file=(s:Scope)=>path.join(Path.state,"vault-http",createHash("sha256").update(JSON.stringify([s.sessionID,s.projectID,path.resolve(s.directory)])).digest("hex")+".json")
export function current(scope:Scope):number {try{const v=JSON.parse(fs.readFileSync(file(scope),"utf8"));return v.sessionID===scope.sessionID&&v.projectID===scope.projectID&&path.resolve(v.directory)===path.resolve(scope.directory)&&Number.isFinite(v.expiresAt)&&v.expiresAt>Date.now()?v.expiresAt:0}catch{return 0}}
/** Operator UI only; no model tool can enable it. Exact chat/project, one hour, OFF by default. */
export function set(scope:Scope,enabled:boolean){if(!scope.sessionID||!scope.projectID||!path.isAbsolute(scope.directory))throw Error("Verified Vault owner required");fs.mkdirSync(path.dirname(file(scope)),{recursive:true,mode:0o700});const temp=file(scope)+"."+randomUUID()+".tmp";fs.writeFileSync(temp,JSON.stringify({...scope,expiresAt:enabled?Date.now()+3600000:0}),{mode:0o600});fs.renameSync(temp,file(scope))}
export function requireAccess(scope:Scope){if(!current(scope))throw Error("Vault HTTP injection is OFF for this exact chat/project. Only the operator's Security arrow can enable it.")}
