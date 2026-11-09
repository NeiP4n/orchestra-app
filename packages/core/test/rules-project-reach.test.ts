import { expect, test } from "bun:test"
import { Effect } from "effect"
import { Rules } from "../src/rules"
import { readFileSync } from "node:fs"

test("rules reach checks two sessions with different owners even when cwd is identical", async () => {
 const projects=[{id:"prj_a",directory:"/same"},{id:"prj_b",directory:"/same"}]
 const sessions=[{id:"ses_a",owner:"prj_a",location:{directory:"/same"}},{id:"ses_b",owner:"prj_b",location:{directory:"/same"}}]
 let checks=0
 const orchestra={projects:()=>Effect.succeed(projects),owns:(project:any,session:any)=>{checks++;return Effect.succeed(project.id===session.owner)}} as any
 const store={get:(id:string)=>{const session=sessions.find(i=>i.id===id);return session?Effect.succeed(session):Effect.fail(new Error("missing"))}} as any
 const reach=(projectID:string,sessionID:string)=>Rules.sessionReach({projectID,sessionID,sessions:store,orchestra})
 expect(await Effect.runPromise(reach("prj_a","ses_a"))).toBe("session:ses_a")
 expect(await Effect.runPromise(reach("prj_b","ses_b"))).toBe("session:ses_b")
 for(const [project,session] of [["prj_a","ses_b"],["prj_b","ses_a"],["missing","ses_a"],["prj_a","missing"]])
  expect((await Effect.runPromise(Effect.exit(reach(project!,session!))))._tag).toBe("Failure")
 expect(checks).toBe(4)
 const failed={projects:()=>Effect.die(new Error("storage unavailable")),owns:()=>Effect.succeed(true)} as any
 expect((await Effect.runPromise(Effect.exit(Rules.sessionReach({projectID:"prj_a",sessionID:"ses_a",sessions:store,orchestra:failed}))))._tag).toBe("Failure")
})
test("tool resolves reach before any list/add/remove branch",()=>{
 const source=readFileSync(new URL("../src/tool/plugin/rules.ts",import.meta.url),"utf8")
 const guard=source.indexOf("Rules.sessionReach({ projectID: scopes.project")
 expect(guard).toBeGreaterThan(0)
 for(const branch of ['if (input.action === "list")','if (input.action === "remove")','const added = yield* Rules.add'])expect(guard).toBeLessThan(source.indexOf(branch))
 expect(source).not.toContain('scope: Rules.sessionScope(input.session)')
})
