import {expect,test} from "bun:test"
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,symlinkSync} from "node:fs"
import path from "node:path"
import os from "node:os"
import {oauthClientEnvironment} from "../src/oauth-client-file"
test("local OAuth file parses only allowed assignments and env overrides without shell expansion",()=>{
 const root=mkdtempSync(path.join(os.tmpdir(),"oauth-file-")),file=path.join(root,"credentials.env")
 try{
  writeFileSync(file,'# local only\nORCHESTRA_ANTIGRAVITY_CLIENT_ID="own.apps.googleusercontent.com"\nORCHESTRA_ANTIGRAVITY_CLIENT_SECRET=\'test-only-${NO_EXPANSION}\'\n',{mode:0o600})
  expect(oauthClientEnvironment({},file)).toEqual({ORCHESTRA_ANTIGRAVITY_CLIENT_ID:"own.apps.googleusercontent.com",ORCHESTRA_ANTIGRAVITY_CLIENT_SECRET:"test-only-${NO_EXPANSION}"})
  expect(oauthClientEnvironment({ORCHESTRA_ANTIGRAVITY_CLIENT_ID:"env-own"},file).ORCHESTRA_ANTIGRAVITY_CLIENT_ID).toBe("env-own")
  writeFileSync(file,"OTHER_ENV=private-canary")
  expect(()=>oauthClientEnvironment({},file)).toThrow("format and permissions")
  try{oauthClientEnvironment({},file)}catch(e){expect(String(e)).not.toContain("private-canary")}
  rmSync(file);expect(oauthClientEnvironment({},file)).toEqual({})
  const target=path.join(root,"target");writeFileSync(target,"ORCHESTRA_ANTIGRAVITY_CLIENT_ID=own")
  symlinkSync(target,file);expect(()=>oauthClientEnvironment({},file)).toThrow("format and permissions")
 }finally{rmSync(root,{recursive:true,force:true})}
})
