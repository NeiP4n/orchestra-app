/** Scheduling hints only, never filesystem authorization or a write sandbox. */
export const SCOPE_KEY = "orchestra.taskScope.v1"
export function scopePaths(value:unknown):string[]|undefined {
 if(!Array.isArray(value)||value.length===0||value.length>64)return
 const paths=value.map(v=>typeof v==="string"?v.replace(/\\/g,"/").replace(/\/$/,""):"")
 if(paths.some(p=>!p||p.startsWith("/")||p.includes(":")||p.split("/").some(s=>!s||s==="."||s==="..")||/[\x00-\x1f*?]/.test(p)))return
 return [...new Set(paths)].sort()
}
export function disjointScopes(next:unknown,active:readonly unknown[]):boolean {
 const a=scopePaths(next);if(!a||!active.length)return false
 return active.every(value=>{const b=scopePaths(value);return !!b&&a.every(x=>b.every(y=>x!==y&&!x.startsWith(y+"/")&&!y.startsWith(x+"/")))})
}
