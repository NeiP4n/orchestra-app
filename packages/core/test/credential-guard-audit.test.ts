import {test,expect} from "bun:test"
import {ShellTool} from "../src/tool/plugin/shell.js"
test("every refused obfuscated credential access records metadata only and says do not bypass",()=>{
 const rows:unknown[]=[]
 for(const command of ["node -e \"require('fs').readFileSync('tok'+'en.json')\"", "node -e \"require('fs').readFileSync(Buffer.from('dG9rZW4uanNvbg==','base64').toString())\"", "Get-ChildItem ~/.config/orchestra -Filter *dod* -Recurse"]){
  expect(ShellTool.forbiddenCommand(command)).toContain("Do not bypass")
  ShellTool.recordGuardRefusal(command,{sessionID:"test-session",agent:"tester"},row=>rows.push(row))
 }
 expect(rows).toHaveLength(3)
 expect(JSON.stringify(rows)).not.toContain("dG9rZW4")
 expect(JSON.stringify(rows)).not.toContain("readFileSync")
 expect(JSON.stringify(rows)).toContain("sha256")
 expect(ShellTool.forbiddenCommand("Get-ChildItem ~/.config/orchestra -Filter *dod*")).toContain("Use dod")
})

import {CredentialGuard} from '../src/credential-guard.js'
import {RoomRules} from '@orchestra/schema/room-rules'
test('constant encodings and camelCase credential filenames cannot bypass the guard',()=>{
 const paths=['githubToken.json','apiToken.json','botToken.json','MYTOKEN.json']
 for(const path of paths)expect(RoomRules.protectedFile(undefined,path)).toBeDefined()
 expect(RoomRules.protectedFile(undefined,'design-tokens.json')).toBeUndefined()
 const commands=[
  "node -e 'readFileSync(`tok`+`en.json`)'",
  "node -e \"readFileSync(atob('dG9rZW4uanNvbg=='))\"",
  "node -e \"readFileSync(Buffer.from('dG9rZW4uanNvbg==','base64'))\"",
  "node -e \"readFileSync(Buffer.from('746f6b656e2e6a736f6e','hex'))\"",
  "node -e \"readFileSync('\\x74\\x6f\\x6b\\x65\\x6e.json')\"",
  "[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('dG9rZW4uanNvbg=='))",
 ]
 for(const command of commands){
  expect(ShellTool.forbiddenCommand(command)).toContain('Do not bypass')
  expect(CredentialGuard.suspicious(command)).toBe(true)
 }
 const rows:unknown[]=[]
 CredentialGuard.record("atob('aGVsbG8=')",{sessionID:'s'},'construction',row=>rows.push(row))
 expect(JSON.stringify(rows)).toContain('credential-guard.construction')
 expect(JSON.stringify(rows)).not.toContain('aGVsbG8')
 for(const action of ['read','write','edit'])expect(CredentialGuard.files(action,['apiToken.json'],{sessionID:'s'},row=>rows.push(row))).toBe(true)
 expect(JSON.stringify(rows)).not.toContain('apiToken.json')
})
