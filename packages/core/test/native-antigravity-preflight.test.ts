import { expect, test } from "bun:test"
import { Cause, Effect, Exit } from "effect"
import { HttpClient } from "effect/unstable/http"
import { authorize } from "@orchestra/core/plugin/provider/google-antigravity"
import { AntigravityOAuthConfigurationError, requireAntigravityClientSecret } from "@orchestra/core/plugin/provider/google-antigravity-env"
import { Integration } from "@orchestra/core/integration"

test("native OAuth preflight preserves the typed configuration error before network or callback startup", async () => {
  const previous = process.env.ORCHESTRA_ANTIGRAVITY_CLIENT_SECRET
  delete process.env.ORCHESTRA_ANTIGRAVITY_CLIENT_SECRET
  try {
    const http = new Proxy({}, { get() { throw new Error("network must not be used") } }) as HttpClient.HttpClient
    const exit = await Effect.runPromise(Effect.scoped(authorize(http)).pipe(Effect.exit))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isSuccess(exit)) throw new Error("Expected preflight failure")
    expect(Cause.hasDies(exit.cause)).toBe(false)
    const error = Cause.squash(exit.cause)
    expect(error).toBeInstanceOf(AntigravityOAuthConfigurationError)
    const publicError = new Integration.AuthorizationError({ cause: error })
    expect(publicError.message).toContain("ORCHESTRA_ANTIGRAVITY_CLIENT_SECRET")
    expect(publicError.message).toContain("bun script/init-oauth-client.mjs && notepad .orchestra\\credentials.env")
    expect(publicError.message).not.toContain("An error occurred in Effect.try")
  } finally {
    if (previous === undefined) delete process.env.ORCHESTRA_ANTIGRAVITY_CLIENT_SECRET
    else process.env.ORCHESTRA_ANTIGRAVITY_CLIENT_SECRET = previous
  }
})

test("native preflight does not embed secret values in configuration errors", () => {
  expect(requireAntigravityClientSecret({ ORCHESTRA_ANTIGRAVITY_CLIENT_SECRET: "private-config-canary" })).toBe("private-config-canary")
  expect(new AntigravityOAuthConfigurationError().message).not.toContain("private-config-canary")
})

test("custom public client omits secret while default still requires it",async()=>{
 const {antigravityClientParams}=await import("@orchestra/core/plugin/provider/google-antigravity-env")
 expect(antigravityClientParams({ORCHESTRA_ANTIGRAVITY_CLIENT_ID:"own-public.apps.googleusercontent.com"})).toEqual({client_id:"own-public.apps.googleusercontent.com"})
 expect(antigravityClientParams({ORCHESTRA_ANTIGRAVITY_CLIENT_ID:"own-private.apps.googleusercontent.com",ORCHESTRA_ANTIGRAVITY_CLIENT_SECRET:"test-only-placeholder"})).toEqual({client_id:"own-private.apps.googleusercontent.com",client_secret:"test-only-placeholder"})
 expect(()=>antigravityClientParams({})).toThrow("ORCHESTRA_ANTIGRAVITY_CLIENT_SECRET")
})

test("native and plugin preflight read the gitignored local client file in the launch folder", async()=>{
 const {mkdtemp,mkdir,writeFile,rm}=await import("node:fs/promises")
 const os=await import("node:os"),path=await import("node:path")
 const root=await mkdtemp(path.join(os.tmpdir(),"oauth-local-preflight-"))
 try{
  await mkdir(path.join(root,".orchestra"))
  await writeFile(path.join(root,".orchestra/credentials.env"),"ORCHESTRA_ANTIGRAVITY_CLIENT_SECRET=fixture-private-local-only\n")
  const native=path.resolve(import.meta.dir,"../src/plugin/provider/google-antigravity-env.ts")
  const plugin=path.resolve(import.meta.dir,"../../plugin-antigravity-auth/src/constants.ts")
  const child=Bun.spawn([process.execPath,"-e",`const n=await import(${JSON.stringify(native)});const p=await import(${JSON.stringify(plugin)});if(n.requireAntigravityClientSecret()!=="fixture-private-local-only"||p.requireAntigravityClientSecret()!=="fixture-private-local-only")process.exit(2);console.log("local file read by native and plugin: PASS")`],{cwd:root,env:{...process.env,ORCHESTRA_ANTIGRAVITY_CLIENT_SECRET:undefined,ORCHESTRA_ANTIGRAVITY_CLIENT_ID:undefined},stdout:"pipe",stderr:"pipe"})
  const output=await new Response(child.stdout).text();const error=await new Response(child.stderr).text()
  expect(await child.exited).toBe(0);expect(error).toBe("");expect(output).toContain("PASS");expect(output).not.toContain("fixture-private-local-only")
 }finally{await rm(root,{recursive:true,force:true})}
})
