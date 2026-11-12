import {test,expect} from "bun:test"
test("actual sidebar limit JSX keeps persistence and isolation without leaking mocked theme into other suites",()=>{
 const child=Bun.spawnSync([process.execPath,"test/fixture/schedule-limit-case.tsx"],{cwd:import.meta.dir+"/..",env:process.env})
 expect(child.exitCode).toBe(0)
 expect(child.stdout.toString()).toContain("schedule dialog assertions passed")
 if(child.exitCode)throw Error(child.stderr.toString())
})
