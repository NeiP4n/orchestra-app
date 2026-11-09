import {expect,test} from "bun:test"
import {Effect} from "effect"
import {Plot} from "../src/plot"
import {readFileSync} from "node:fs"

test("shell denies any live foreign plot, including opaque writes, and allows an own plot",async()=>{
 const plot={id:"plot_b",purpose:"foreign task"} as any
 let allowed=false;const directories:string[]=[]
 const plots={list:(directory:string)=>{directories.push(directory);return Effect.succeed([plot])},holds:()=>Effect.succeed(allowed)}
 const input={sessionID:"ses_a",directories:["/project","/project/other"]} as any
 expect((await Effect.runPromise(Effect.exit(Plot.guardShell(plots,input))))._tag).toBe("Failure")
 allowed=true
 expect((await Effect.runPromise(Effect.exit(Plot.guardShell(plots,input))))._tag).toBe("Success")
 expect(directories).toContain("/project/other")
 const broken={...plots,list:()=>Effect.die(new Error("unreadable plots"))}
 expect((await Effect.runPromise(Effect.exit(Plot.guardShell(broken,input))))._tag).toBe("Failure")
 const source=readFileSync(new URL("../src/tool/plugin/shell.ts",import.meta.url),"utf8")
 expect(source.indexOf("yield* Plot.guardShell")).toBeLessThan(source.indexOf("yield* permission.assert"))
 expect(source).toContain("caller.location.directory, target.absolute")
})
