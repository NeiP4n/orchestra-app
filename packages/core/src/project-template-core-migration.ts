export * as ProjectTemplateCoreMigration from "./project-template-core-migration.js"
import { isDeepStrictEqual } from "node:util"
import { ProjectTemplateV2 as V2 } from "./project-template-v2.js"
export interface Change { role: string; fields: string[]; fromHash: string; toHash: string }
const reserved = new Set(["orchestrator", "team-browser-agent"])
const stable = (v: unknown): unknown => Array.isArray(v) ? v.map(stable) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,x])=>[k,stable(x)])) : v
export const fingerprint = (v: unknown) => V2.hash(JSON.stringify(stable(v)))
/** Explicit prospective copy only. Never installs or edits a global role, source template or rulebook. */
export function prepare(text: string, current: readonly V2.Role[]) {
 const source=V2.preview(text)
 if(!source.ok)throw Error("Invalid process template or unsupported fields.")
 const changes: Change[]=[]
 const roles=source.value.bundle.process.roles.map(role=>{
  if(!reserved.has(role.agent))return role
  const matches=current.filter(r=>r.agent===role.agent)
  if(matches.length!==1)throw Error("Canonical built-in role is unavailable or ambiguous.")
  const target=matches[0]
  const before=role as unknown as Record<string,unknown>, after=target as unknown as Record<string,unknown>
  if(!isDeepStrictEqual(role,target))changes.push({role:role.agent,fields:[...new Set([...Object.keys(role),...Object.keys(target)])].filter(key=>!isDeepStrictEqual(before[key],after[key])).sort(),fromHash:fingerprint(role),toHash:fingerprint(target)})
  return target
 })
 const bundle={...source.value.bundle,process:{...source.value.bundle.process,roles}}
 const preview=V2.preview(JSON.stringify(bundle))
 if(!preview.ok)throw Error("Invalid process template or unsupported fields.")
 return {...preview.value,changes,sourceDigest:source.value.digest}
}
