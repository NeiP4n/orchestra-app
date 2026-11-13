import { expect } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { Effect, Logger } from "effect"
import { Global } from "@orchestra/util/global"
import { ProjectTemplateV2 as V2 } from "@orchestra/core/project-template-v2"
import { ProjectTemplateV2Library as Library } from "@orchestra/core/project-template-v2-library"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { ServerFetch } from "../src/fetch"

for (const failWrite of [false, true]) it.live(
  failWrite ? "migrated core-role create keeps a failed session write private and retries exact identities" : "migrated core-role create succeeds on its first confirm without a session fault",
  () => Effect.gen(function* () {
  const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("template-session-retry-")))
  const source = path.join(tmp.path, "source"), data = path.join(tmp.path, "data"), database = path.join(tmp.path, "database.sqlite")
  yield* Effect.promise(() => mkdir(source))
  const global = Global.layerWith({ data, cache:path.join(tmp.path,"cache"),config:path.join(tmp.path,"config"),state:path.join(tmp.path,"state"),tmp:path.join(tmp.path,"tmp"),bin:path.join(tmp.path,"bin"),log:path.join(tmp.path,"logs"),repos:path.join(tmp.path,"repos") })
  const messages: unknown[] = []
  const handler = yield* ServerFetch.make({app:{version:"1.0.0"},database:{path:database},fs:{filewatcher:false},models:{fetch:false},config:{directory:tmp.path,project:false,content:"{}"}}, { allowUnauthenticated:true, overrides:[Global.node.replace(global)] }).pipe(Effect.provide(Logger.layer([Logger.make(entry=>messages.push(entry.message))],{mergeWithExisting:false})))
  const call = (route:string, body?:unknown) => Effect.promise(async () => {
    const response = await handler(new Request("http://orchestra.local"+route,{method:body===undefined?"GET":"POST",headers:{"content-type":"application/json"},body:body===undefined?undefined:JSON.stringify(body)}))
    const text=await response.text(); return {status:response.status,body:text?JSON.parse(text):undefined}
  })
  const original = (yield* call("/api/orchestra/project",{name:"Source",directory:source})).body
  const capture = yield* call("/api/orchestra/project-template/prepare-save",{projectID:original.id,browsers:[]})
  expect(capture.status).toBe(200)
  const bundle = JSON.parse(capture.body.details)
  bundle.process.roles.find((role:{agent:string})=>role.agent==="orchestrator").rules += " Older reviewed role."
  const preview = V2.preview(JSON.stringify(bundle)); if(!preview.ok)throw Error(preview.error)
  yield* Effect.promise(() => Library.local(data).saveSerialized(preview.value.text,"old-role",preview.value.digest))
  const refused = yield* call("/api/orchestra/project-template/prepare-create",{templateID:"process:old-role",settingsDirectory:source})
  expect(refused.status).toBe(400); expect(refused.body.kind).toBe("TEMPLATE_CORE_ROLE")
  const prepared = yield* call("/api/orchestra/project-template/prepare-create",{templateID:"process:old-role",settingsDirectory:source,migrateCore:true})
  expect(prepared.status).toBe(200); expect(prepared.body.roleChanges).toHaveLength(1)
  const db = yield* Effect.acquireRelease(Effect.sync(()=>new Database(database)),db=>Effect.sync(()=>db.close()))
  if (!failWrite) {
    const created = yield* call("/api/orchestra/project-template/confirm-create",{token:prepared.body.token})
    expect(created.status).toBe(200)
    expect((yield* call("/api/session/"+created.body.mainSessionID)).body.data.agent).toBe("orchestrator")
    expect((yield* call("/api/orchestra/project")).body).toHaveLength(2)
    expect((yield* call("/api/orchestra/project-template/confirm-create",{token:prepared.body.token})).body).toEqual(created.body)
    return
  }
  db.run("CREATE TRIGGER test_fail_template_session BEFORE INSERT ON session_v2 BEGIN SELECT RAISE(ABORT, 'PRIVATE_SESSION_FAILURE_CANARY'); END")
  const failed = yield* call("/api/orchestra/project-template/confirm-create",{token:prepared.body.token})
  expect(failed.status).toBe(400)
  expect(failed.body.kind).toBe("TEMPLATE_FAILED")
  expect(JSON.stringify(failed.body)).not.toContain("PRIVATE_")
  expect(JSON.stringify(messages)).not.toContain("PRIVATE_")
  expect(JSON.stringify(messages)).toContain('"stage":"base-sessions"')
  const receipt = JSON.parse((db.query("SELECT value FROM kv WHERE key = ?").get("orchestra/template-import/"+prepared.body.token) as {value:string}).value)
  expect(receipt.phase).toBe("process")
  expect((db.query("SELECT count(*) AS n FROM session_v2 WHERE id = ?").get(receipt.plan.mainSessionID) as {n:number}).n).toBe(0)
  expect((yield* call("/api/orchestra/project")).body.map((row:{id:string})=>row.id)).toEqual([original.id])
  db.run("DROP TRIGGER test_fail_template_session")
  const retried = yield* call("/api/orchestra/project-template/confirm-create",{token:prepared.body.token})
  expect(retried.status).toBe(200)
  expect(retried.body.projectID).toBe(receipt.projectID); expect(retried.body.mainSessionID).toBe(receipt.plan.mainSessionID)
  expect((yield* call("/api/orchestra/project-template/confirm-create",{token:prepared.body.token})).body).toEqual(retried.body)
  expect((yield* call("/api/orchestra/project")).body).toHaveLength(2)
  expect((db.query("SELECT count(*) AS n FROM session_v2 WHERE id = ?").get(receipt.plan.mainSessionID) as {n:number}).n).toBe(1)
}),30_000)
