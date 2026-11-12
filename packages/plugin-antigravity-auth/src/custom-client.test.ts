import {expect,test} from "bun:test"
import {antigravityClientParams,antigravityClientID} from "./constants"
import {authorizeAntigravity} from "./antigravity/oauth"
test("plugin uses own public client and PKCE without inventing a client secret",async()=>{
 const previousID=process.env.ORCHESTRA_ANTIGRAVITY_CLIENT_ID,previousSecret=process.env.ORCHESTRA_ANTIGRAVITY_CLIENT_SECRET
 try{
  process.env.ORCHESTRA_ANTIGRAVITY_CLIENT_ID="own-public.apps.googleusercontent.com";delete process.env.ORCHESTRA_ANTIGRAVITY_CLIENT_SECRET
  expect(antigravityClientID()).toBe("own-public.apps.googleusercontent.com")
  expect(antigravityClientParams()).toEqual({client_id:"own-public.apps.googleusercontent.com"})
  const auth=await authorizeAntigravity()
  const url=new URL(auth.url)
  expect(url.searchParams.get("client_id")).toBe("own-public.apps.googleusercontent.com")
  expect(url.searchParams.get("code_challenge_method")).toBe("S256")
  expect(url.searchParams.has("client_secret")).toBe(false)
 }finally{
  if(previousID===undefined)delete process.env.ORCHESTRA_ANTIGRAVITY_CLIENT_ID;else process.env.ORCHESTRA_ANTIGRAVITY_CLIENT_ID=previousID
  if(previousSecret===undefined)delete process.env.ORCHESTRA_ANTIGRAVITY_CLIENT_SECRET;else process.env.ORCHESTRA_ANTIGRAVITY_CLIENT_SECRET=previousSecret
 }
})
