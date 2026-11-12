export * as DeliveryRecall from "./delivery-recall.js"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
const execute = promisify(execFile)
const git = async (directory: string, args: string[]) => (await execute("git",["--no-pager","-c","core.fsmonitor=false",...args],{cwd:directory,windowsHide:true,timeout:3000,maxBuffer:128*1024})).stdout.trim()
export async function inspect(directory: string) {
  try {
    const head=await git(directory,["rev-parse","--verify","HEAD"])
    const commits=await git(directory,["log","-12","--format=%h %s"])
    const branches=await git(directory,["for-each-ref","--count=16","--format=%(refname:short) %(objectname:short)","refs/heads/"])
    const dirty=await git(directory,["status","--short","--untracked-files=no"])
    return {head,commits,branches,dirty}
  }catch{return undefined}
}
export const block = (state: Awaited<ReturnType<typeof inspect>>) => state ? [
  "# Prior delivery checkpoint (live git, not a claim that the task is done)",
  `HEAD ${state.head}`, `Local branches:\n${state.branches}`, `Recent commits:\n${state.commits}`,
  state.dirty ? `Uncommitted tracked files:\n${state.dirty}` : "No tracked local edits.",
  "Before repeating past DONE work, compare the user's request with these commits, the current code and prior worker reports. Reuse already-shipped work; implement only the missing scope. A report without commit/branch is local-only, never durable delivery. Verify any older delivery reference with git before trusting it.",
].join("\n") : "# Prior delivery checkpoint\nGit history could not be verified. Inspect prior reports/current files before repeating work; do not treat a previous DONE as a persisted change."
export async function verify(directory: string, report: string) {
  if (/\blocal[ -]only\b|\bonly locally\b|только локально/iu.test(report))return true
  const refs=[...report.matchAll(/(?:\bcommit|\bsha|коммит)\s*[:=]?\s*([a-f0-9]{7,40})\b/giu)].map(match=>match[1]!)
  const branches=[...report.matchAll(/(?:\bbranch|ветк[ае])\s*[:=]?\s*[`"']?([\w./-]+)/giu)].map(match=>match[1]!)
  for(const ref of refs)try{await git(directory,["cat-file","-e",`${ref}^{commit}`]);return true}catch{}
  for(const branch of branches)try{await git(directory,["show-ref","--verify",`refs/heads/${branch}`]);return true}catch{}
  return false
}
