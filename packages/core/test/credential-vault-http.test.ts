import {test,expect} from "bun:test"
import {mkdtemp,rm,readFile} from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import {EventEmitter} from "node:events"
import {CredentialVault} from "../src/credential-vault/index"
import {VaultAccess} from "../src/credential-vault/access"
import {allowedUrl,httpSummary,nativeHttp,HTTP_SCRIPT} from "../src/credential-vault/http"
test("fixed secret-backed request stays OFF, project scoped and name-only; raw output cannot pass",async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),"vault-http-")),prior=process.env.ORCHESTRA_STATE_DIR;process.env.ORCHESTRA_STATE_DIR=dir
 const scope={sessionID:"ses_a",projectID:"prj_a",directory:dir}
 let calls=0
 const options={directory:dir,projectID:"prj_a",collector:{collect:async()=>({name:"API",site:"https://api.example.invalid/v1",blob:"U0VBTEVE",backend:"windows-dpapi-user-v1" as const})},checkUrl:async()=>{},request:async(blob:string,url:string)=>{calls++;expect(blob).toBe("U0VBTEVE");expect(url).toBe("https://api.example.invalid/v1/models");return {status:200,durationMs:42}}}
 try{
  const access=CredentialVault.make(options);await access.writeFromOperator()
  expect(await access.list()).toEqual([{id:expect.any(String),name:"API"}])
  const foreign=CredentialVault.make({...options,projectID:"prj_b"});expect(await foreign.list()).toEqual([])
  const existing=(await access.list())[0]!
  await access.bindFromOperator(existing.id,"prj_b");expect((await foreign.list())[0]?.name).toBe("API")
  await expect(foreign.checkHttp("API","https://api.example.invalid/v1/models",{...scope,projectID:"prj_b"})).rejects.toThrow("OFF")
  await expect(access.checkHttp("API","https://api.example.invalid/v1/models",scope)).rejects.toThrow("OFF");expect(calls).toBe(0)
  VaultAccess.set(scope,true);expect(await access.checkHttp("API","https://api.example.invalid/v1/models",scope)).toEqual({status:200,durationMs:42});expect(calls).toBe(1)
  for(const changed of [{...scope,sessionID:"ses_b"},{...scope,projectID:"prj_b"},{...scope,directory:path.join(dir,"foreign")}])await expect(access.checkHttp("API","https://api.example.invalid/v1/models",changed)).rejects.toThrow()
  for(const url of ["https://evil.invalid/v1/models","http://api.example.invalid/v1/models","https://api.example.invalid/v1/charge","https://api.example.invalid/v1/models?token=x"])await expect(access.checkHttp("API",url,scope)).rejects.toThrow()
  expect(calls).toBe(1)
  await expect(CredentialVault.make({...options,request:async()=>({status:200,durationMs:1,body:"fake-SECRET"})}).checkHttp("API","https://api.example.invalid/v1/models",scope)).rejects.toThrow("withheld")
  expect(await readFile(path.join(dir,"registry.json"),"utf8")).not.toContain("fake-SECRET")
  VaultAccess.set(scope,false);await expect(access.checkHttp("API","https://api.example.invalid/v1/models",scope)).rejects.toThrow("OFF")
  expect(access).not.toHaveProperty("decrypt");expect(access).not.toHaveProperty("get")
 }finally{if(prior===undefined)delete process.env.ORCHESTRA_STATE_DIR;else process.env.ORCHESTRA_STATE_DIR=prior;await rm(dir,{recursive:true,force:true})}
})
test("only numeric native summary crosses stdout; unsupported OS fails closed",async()=>{
 for(const value of [{status:200,durationMs:1,body:"SECRET"},{status:"200",durationMs:1},{status:200,durationMs:-1},{status:700,durationMs:0}])expect(()=>httpSummary(value)).toThrow()
 expect(allowedUrl("https://api.example.invalid/v1","https://api.example.invalid/v1/models").href).toContain("/models")
 await expect(nativeHttp("linux")("U0VBTEVE","https://example.invalid/models")).rejects.toThrow("No plaintext fallback")
 expect(HTTP_SCRIPT).toContain("AllowAutoRedirect=$false");expect(HTTP_SCRIPT).toContain("ResponseHeadersRead");expect(HTTP_SCRIPT).not.toContain("ReadAsStringAsync");expect(HTTP_SCRIPT).not.toContain("Write-Host");expect(HTTP_SCRIPT).toContain("Bearer");expect(HTTP_SCRIPT).toContain("::Unprotect");expect(HTTP_SCRIPT).toContain("[Array]::Clear")
})
test("native wrapper never sends plaintext in argv/stdin and rejects output with extra secret-like field",async()=>{
 const child=new EventEmitter() as any;child.stdout=new EventEmitter();child.stdout.setEncoding=()=>{};child.stderr={resume(){}};let stdin="",args:string[]=[];child.stdin=new EventEmitter();child.stdin.end=(v:string)=>{stdin=v;queueMicrotask(()=>{child.stdout.emit("data",JSON.stringify({status:200,durationMs:1,body:"fake-SECRET"}));child.emit("close",0)})};child.kill=()=>true
 const runner=nativeHttp("win32",((_exe:string,a:string[])=>{args=a;return child}) as any)
 await expect(runner("U0VBTEVE","https://example.invalid/models")).rejects.toThrow("output withheld")
 expect(stdin).toBe(JSON.stringify({blob:"U0VBTEVE",url:"https://example.invalid/models"}));expect(args.join(" ")).not.toContain("fake-SECRET");expect(stdin).not.toContain("fake-SECRET")
})
