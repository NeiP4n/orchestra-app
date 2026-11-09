import { expect, test } from "bun:test"
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import os from "node:os"
import { SafetyConfig } from "../src/safety-config"
import { runtimeLimits } from "../src/autoloop/runtime-limits"
import { Limits } from "../src/limits"
import { BrowserLocalTest } from "../src/browser/local-test"
test("operator acknowledgement disables time/tokens/steps and restores with one action; env off alone does not",()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),"safety-proof-")),prior=process.env.ORCHESTRA_STATE_DIR;process.env.ORCHESTRA_STATE_DIR=dir
 try{
  expect(Limits.enforced({ORCHESTRA_DISABLE_LIMITS:"1"})).toBe(true)
  expect(()=>SafetyConfig.write({version:1,disabled:true})).toThrow("РАЗРЕШИТЬ")
  expect(Limits.enforced()).toBe(true)
  SafetyConfig.write({version:1,disabled:true},"РАЗРЕШИТЬ")
  expect(runtimeLimits({maxHops:8})?.maxHops).toBe(Infinity);expect(runtimeLimits()?.failureRepeatStop).toBe(Infinity);expect(Limits.steps([1,2])).toBeUndefined();expect(Limits.drainWallClockMs()).toBeUndefined();expect(Limits.drainTokenBudget()).toBeUndefined();expect(Limits.timeout(5,10)).toBe(Limits.UNBOUNDED_MS)
  expect(Limits.enforced({ORCHESTRA_ENFORCE_LIMITS:"1"})).toBe(true)
  SafetyConfig.restore();expect(runtimeLimits({maxHops:8})?.maxHops).toBe(8);expect(Limits.enforced()).toBe(true);expect(Limits.steps([1,2])).toBe(1)
  writeFileSync(path.join(dir,"operator-safety.json"),JSON.stringify({version:1,disabled:true}));expect(Limits.enforced()).toBe(true)
 }finally{if(prior===undefined)delete process.env.ORCHESTRA_STATE_DIR;else process.env.ORCHESTRA_STATE_DIR=prior;rmSync(dir,{recursive:true,force:true})}
})
test("numeric service config is live, expansion needs exact word, malformed config fails closed",()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),"safety-proof-")),prior=process.env.ORCHESTRA_STATE_DIR;process.env.ORCHESTRA_STATE_DIR=dir
 try{
  SafetyConfig.write({version:1,drainMs:60000,drainTokens:1000,browserMax:2})
  expect(Limits.drainWallClockMs()).toBe(60000);expect(Limits.drainTokenBudget()).toBe(1000)
  expect(()=>SafetyConfig.write({version:1,browserMax:3})).toThrow();expect(()=>SafetyConfig.write({version:1,localTest:true})).toThrow()
  SafetyConfig.write({version:1,drainMs:120000,drainTokens:2000,browserMax:3,localTest:true},"РАЗРЕШИТЬ")
  expect(Limits.drainWallClockMs()).toBe(120000);expect(BrowserLocalTest.allowed("http://127.0.0.1:1234")).toBe(true);expect(BrowserLocalTest.allowed("https://example.com")).toBe(false)
  expect(Limits.drainWallClockMs({ORCHESTRA_DRAIN_WALL_CLOCK_MS:"500"})).toBe(500)
  writeFileSync(path.join(dir,"operator-safety.json"),"broken");expect(SafetyConfig.disabled()).toBe(false)
 }finally{if(prior===undefined)delete process.env.ORCHESTRA_STATE_DIR;else process.env.ORCHESTRA_STATE_DIR=prior;rmSync(dir,{recursive:true,force:true})}
})
