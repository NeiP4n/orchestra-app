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
