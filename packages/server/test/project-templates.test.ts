import { expect } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import { Global } from "@orchestra/util/global"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { ServerFetch } from "../src/fetch"

for (const version of ["1.0.0", "1.0.0+96e173dfb"]) it.live(
  `project template HTTP save -> list -> create with ${version} captures configuration and creates fresh inert real stores`,
  () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("template-http-"))),
        source = path.join(tmp.path, "source")
      yield* Effect.promise(() => mkdir(source))
      const global = Global.layerWith({
        data: path.join(tmp.path, "data"),
        cache: path.join(tmp.path, "cache"),
        config: path.join(tmp.path, "config"),
        state: path.join(tmp.path, "state"),
        tmp: path.join(tmp.path, "tmp"),
        bin: path.join(tmp.path, "bin"),
        log: path.join(tmp.path, "logs"),
        repos: path.join(tmp.path, "repos"),
      })
      const handler = yield* ServerFetch.make(
        {
          app: { version },
          database: { path: ":memory:" },
          fs: { filewatcher: false },
          models: { fetch: false },
          config: { directory: tmp.path, project: false, content: "{}" },
        },
        { allowUnauthenticated: true, overrides: [Global.node.replace(global)] },
      )
      const call = (route: string, method = "GET", body?: unknown) =>
        Effect.promise(async () => {
          const response = await handler(
            new Request("http://orchestra.local" + route, {
              method,
              headers: { "content-type": "application/json" },
              body: body === undefined ? undefined : JSON.stringify(body),
            }),
          )
          const text = await response.text()
          return { status: response.status, body: text ? JSON.parse(text) : undefined }
        })
      const project = (yield* call("/api/orchestra/project", "POST", { name: "Factory", directory: source })).body
      const browserAgent = (yield* call("/api/session", "POST", {
        title: "Inbox",
        agent: "team-browser-agent",
        location: { directory: source },
      })).body.data
      expect((yield* call("/api/orchestra/owner/" + browserAgent.id, "PUT", { projectID: project.id })).status).toBe(
        204,
      )
      yield* Effect.promise(async () => {
        await mkdir(path.join(tmp.path, "data/browser-profiles"), { recursive: true })
        await Bun.write(
          path.join(tmp.path, "data/browser-profiles/brw_source.tabs.json"),
          JSON.stringify({ tabs: [{ url: "https://example.com/inbox", title: "PRIVATE_PAGE_CANARY" }] }),
        )
      })
      const ordinary = (yield* call("/api/session", "POST", {
        title: "Приветствие auto",
        location: { directory: source },
      })).body.data
      expect(ordinary.agent).toBeUndefined()
      expect((yield* call("/api/orchestra/rules/" + encodeURIComponent("orchestrator:" + project.id), "POST", { text: "Report failures and preserve the process." })).status).toBe(200)
      const browsers = [{ id: "brw_source", name: "Inbox", chat: browserAgent.id, mode: "window" }]
      const prepared = yield* call("/api/orchestra/project-template/prepare-save", "POST", {
        projectID: project.id,
        browsers,
      })
      expect(prepared.status).toBe(200)
      expect(prepared.body.triggerReview).toEqual([])
      const captured = JSON.parse(prepared.body.details)
      expect(captured.sessions.find((row: { title: string }) => row.title === "Приветствие auto").role).toBeNull()
      expect(captured.rules).toContainEqual({ scope: "orchestrator", session: null, text: "Report failures and preserve the process." })
      expect(prepared.body.details).not.toContain(project.id)
      expect(prepared.body.details).not.toContain(source)
      expect(prepared.body.details).not.toContain("PRIVATE_PAGE_CANARY")
      expect(prepared.body.details).toContain("https://example.com/inbox")
      expect((yield* call("/api/orchestra/project-template")).body).toEqual([])
      expect(
        (yield* call("/api/orchestra/project-template/confirm-save", "POST", {
          token: prepared.body.token,
          browsers,
        })).status,
      ).toBe(204)
      expect(
        (yield* call("/api/orchestra/project-template/confirm-save", "POST", {
          token: prepared.body.token,
          browsers,
        })).status,
      ).toBe(204)
      const library = (yield* call("/api/orchestra/project-template")).body
      expect(library).toHaveLength(1)
      expect(library[0].name).toBe("Factory")
      const create = yield* call("/api/orchestra/project-template/prepare-create", "POST", {
        templateID: library[0].id,
        settingsDirectory: source,
      })
      expect(create.status).toBe(200)
      expect(create.body.triggerReview).toEqual([])
      expect(
        (yield* call("/api/orchestra/project-template/prepare-create", "POST", {
          templateID: library[0].id,
          settingsDirectory: source,
        })).body.token,
      ).toBe(create.body.token)
      expect((yield* call("/api/orchestra/project")).body).toHaveLength(1)
      const created = yield* call("/api/orchestra/project-template/confirm-create", "POST", {
        token: create.body.token,
      })
      expect(created.status).toBe(200)
      expect(created.body.projectID).not.toBe(project.id)
      expect(created.body.mainSessionID).not.toBe(project.main)
      expect(created.body.browsers.browsers[0]).toMatchObject({ name: "Inbox", mode: "window" })
      expect(created.body.browsers.browsers[0].id).not.toBe("brw_source")
      expect(created.body.browsers.browsers[0].chat).not.toBe(browserAgent.id)
      expect(
        (yield* call("/api/orchestra/project-template/confirm-create", "POST", { token: create.body.token })).body,
      ).toEqual(created.body)
      expect((yield* call("/api/orchestra/project")).body).toHaveLength(2)
      expect(
        (yield* call("/api/orchestra/project-template/prepare-create", "POST", {
          templateID: library[0].id,
          settingsDirectory: source,
        })).body.token,
      ).toBe(create.body.token)
      expect(
        (yield* call("/api/orchestra/project-template/finish-create", "POST", { token: create.body.token })).status,
      ).toBe(204)
      expect(
        (yield* call("/api/orchestra/project-template/prepare-create", "POST", {
          templateID: library[0].id,
          settingsDirectory: source,
        })).body.token,
      ).not.toBe(create.body.token)
      expect((yield* call("/api/orchestra/project-template/" + created.body.projectID + "/browsers")).body).toEqual(
        created.body.browsers,
      )
      const restoredSessions = (yield* call("/api/session?limit=100")).body.data
      const restoredAuto = restoredSessions.find((row: { id: string; title: string }) => row.id !== ordinary.id && row.title === "Приветствие auto")
      expect(restoredAuto).toBeDefined()
      expect(restoredAuto.agent).toBeUndefined()
      expect(restoredAuto.permissions).toEqual([])
      expect(restoredAuto.tokens.input).toBe(0)
      const restoredBrowser = (yield* call("/api/session/" + created.body.browsers.browsers[0].chat)).body.data
      expect(restoredBrowser.agent).toBe("team-browser-agent")
      const restoredRules = (yield* call("/api/orchestra/rules/" + encodeURIComponent("orchestrator:" + created.body.projectID))).body
      expect(restoredRules.map((rule: { text: string }) => rule.text)).toContain("Report failures and preserve the process.")
      const recaptured = yield* call("/api/orchestra/project-template/prepare-save", "POST", {
        projectID: created.body.projectID,
        browsers: created.body.browsers.browsers,
      })
      expect(recaptured.status).toBe(200)
      const restored = JSON.parse(recaptured.body.details)
      expect(restored.sessions.find((row: { title: string }) => row.title === "Приветствие auto").role).toBeNull()
      expect(restored.rules).toContainEqual({ scope: "orchestrator", session: null, text: "Report failures and preserve the process." })
      const main = (yield* call("/api/session/" + created.body.mainSessionID)).body.data
      expect(main.agent).toBe("orchestrator")
      expect(main.permissions).toEqual([])
      expect(main.tokens.input).toBe(0)
      const stale = yield* call("/api/orchestra/project-template/prepare-save", "POST", {
        projectID: project.id,
        browsers,
      })
      expect(stale.status).toBe(200)
      expect(
        (yield* call("/api/orchestra/project/" + project.id, "PATCH", { name: "Changed after review" })).status,
      ).toBe(200)
      const changed = yield* call("/api/orchestra/project-template/confirm-save", "POST", { token: stale.body.token, browsers })
      expect(changed.status).toBe(400)
      expect(changed.body.kind).toBe("TEMPLATE_CHANGED")
      expect(JSON.stringify(changed.body)).not.toContain(source)
      expect(JSON.stringify(changed.body)).not.toContain(project.id)
      expect((yield* call("/api/orchestra/project-template")).body).toHaveLength(1)
      // Foreign binding is now a reviewed, explicit omission in the copy, never
      // an owner adoption. The server still refuses saving it without consent.
      const foreignBrowsers = [{ ...browsers[0], chat: created.body.mainSessionID }]
      const foreign = yield* call("/api/orchestra/project-template/prepare-save", "POST", {
        projectID: project.id, browsers: foreignBrowsers,
      })
      expect(foreign.status).toBe(200)
      expect(foreign.body.browserBindings).toEqual([{ browser: 1, reason: "foreign" }])
      expect(JSON.parse(foreign.body.details).browsers[0].session).toBeUndefined()
      expect(foreign.body.details).not.toContain(created.body.mainSessionID)
      expect((yield* call("/api/orchestra/project-template/confirm-save", "POST", {
        token: foreign.body.token, browsers: foreignBrowsers,
      })).status).toBe(400)
      expect((yield* call("/api/orchestra/project-template")).body).toHaveLength(1)
      expect(
        (yield* call("/api/orchestra/project-template/confirm-create", "POST", { token: "../foreign" })).status,
      ).toBe(400)
      // Unsafe saved links are reviewed by ordinal/reason only, never URL/title/value.
      const privateTabs = { tabs: [
        { url: "https://example.com/portable", title: "PRIVATE_TITLE_CANARY" },
        { url: "https://example.com/search?q=PRIVATE_QUERY_CANARY" },
        { url: "https://example.com/#PRIVATE_FRAGMENT_CANARY" },
        { url: "file:///PRIVATE_PATH_CANARY" },
        { url: "http://localhost:3000/PRIVATE_LOCAL_CANARY" },
        { url: "https://user:PRIVATE_PASSWORD_CANARY@example.com/" },
      ] }
      yield* Effect.promise(() => Bun.write(path.join(tmp.path, "data/browser-profiles/brw_source.tabs.json"), JSON.stringify(privateTabs)))
      const review = yield* call("/api/orchestra/project-template/prepare-save", "POST", { projectID: project.id, browsers })
      expect(review.status).toBe(200)
      expect(review.body.omittedLinks).toEqual([
        { browser: 1, link: 2, reason: "query" }, { browser: 1, link: 3, reason: "fragment" },
        { browser: 1, link: 4, reason: "scheme" }, { browser: 1, link: 5, reason: "local" },
        { browser: 1, link: 6, reason: "credentials" },
      ])
      expect(JSON.stringify(review.body)).not.toContain("PRIVATE_")
      expect(review.body.details).toContain("https://example.com/portable")
      const refused = yield* call("/api/orchestra/project-template/confirm-save", "POST", { token: review.body.token, browsers })
      expect(refused.status).toBe(400)
      expect(refused.body.kind).toBe("TEMPLATE_LINKS")
      expect((yield* call("/api/orchestra/project-template")).body).toHaveLength(1)
      // Changing even an excluded URL invalidates confirmation; no implicit acceptance of a new list.
      privateTabs.tabs[1].url = "https://example.com/search?q=CHANGED_PRIVATE_CANARY"
      yield* Effect.promise(() => Bun.write(path.join(tmp.path, "data/browser-profiles/brw_source.tabs.json"), JSON.stringify(privateTabs)))
      const replaced = yield* call("/api/orchestra/project-template/confirm-save", "POST", { token: review.body.token, browsers, omitUnsafeLinks: true })
      expect(replaced.status).toBe(400)
      expect(replaced.body.kind).toBe("TEMPLATE_CHANGED")
      const reviewedAgain = yield* call("/api/orchestra/project-template/prepare-save", "POST", { projectID: project.id, browsers })
      expect((yield* call("/api/orchestra/project-template/confirm-save", "POST", { token: reviewedAgain.body.token, browsers, omitUnsafeLinks: true })).status).toBe(204)
      expect((yield* call("/api/orchestra/project-template")).body).toHaveLength(2)
      const diskTabs = yield* Effect.promise(() => Bun.file(path.join(tmp.path, "data/browser-profiles/brw_source.tabs.json")).json())
      expect(diskTabs).toEqual(privateTabs)

    }),
  30_000,
)

it.live("Test2/Test3 HTTP export reviews two powered-off browser definitions without adopting foreign or deleted chats",()=>Effect.gen(function*(){
  const tmp=yield* Effect.acquireDisposable(Effect.promise(()=>tmpdir("template-browser-profile-")))
  const global=Global.layerWith({data:path.join(tmp.path,"data"),cache:path.join(tmp.path,"cache"),config:path.join(tmp.path,"config"),state:path.join(tmp.path,"state"),tmp:path.join(tmp.path,"tmp"),bin:path.join(tmp.path,"bin"),log:path.join(tmp.path,"logs"),repos:path.join(tmp.path,"repos")})
  const handler=yield* ServerFetch.make({app:{version:"1.0.0"},database:{path:":memory:"},fs:{filewatcher:false},models:{fetch:false},config:{directory:tmp.path,project:false,content:"{}"}},{allowUnauthenticated:true,overrides:[Global.node.replace(global)]})
  const call=(route:string,body?:unknown)=>Effect.promise(async()=>{
    const response=await handler(new Request("http://orchestra.local"+route,{method:body===undefined?"GET":"POST",headers:{"content-type":"application/json"},body:body===undefined?undefined:JSON.stringify(body)}))
    const text=await response.text();return {status:response.status,body:text?JSON.parse(text):undefined}
  })
  const dirs=[path.join(tmp.path,"test2"),path.join(tmp.path,"test3")]
  yield* Effect.promise(()=>Promise.all(dirs.map(dir=>mkdir(dir))))
  const test2=(yield* call("/api/orchestra/project",{name:"Test2",directory:dirs[0]})).body
  const test3=(yield* call("/api/orchestra/project",{name:"Test3",directory:dirs[1]})).body
  const auto=(yield* call("/api/session",{title:"Приветствие auto",location:{directory:dirs[0]}})).body.data
  const definitions=[{id:"brw_whatsapp",name:"Whatsapp",mode:"window",chat:test3.main},{id:"brw_second",name:"Browser 2",mode:"window",chat:auto.id}]
  const preview=yield* call("/api/orchestra/project-template/prepare-save",{projectID:test2.id,browsers:definitions})
  expect(preview.status).toBe(200)
  expect(preview.body.browserBindings).toEqual([{browser:1,reason:"foreign"}])
  const bundle=JSON.parse(preview.body.details)
  expect(bundle.browsers.map((b:{name:string})=>b.name)).toEqual(["Whatsapp","Browser 2"])
  expect(bundle.browsers[0].session).toBeUndefined()
  const greeting=bundle.sessions.find((s:{title:string})=>s.title==="Приветствие auto")
  expect(greeting.role).toBeNull();expect(bundle.browsers[1].session).toBe(greeting.slot)
  expect(preview.body.details).not.toContain(test3.main)
  expect((yield* call("/api/orchestra/project-template/confirm-save",{token:preview.body.token,browsers:definitions})).status).toBe(400)
  expect((yield* call("/api/orchestra/project-template")).body).toEqual([])
  expect((yield* call("/api/orchestra/project-template/confirm-save",{token:preview.body.token,browsers:definitions,omitInvalidBrowserBindings:true})).status).toBe(204)
  expect((yield* call("/api/orchestra/project-template")).body).toHaveLength(1)
  const deleted=yield* call("/api/orchestra/project-template/prepare-save",{projectID:test2.id,browsers:[{...definitions[0],chat:"ses_deleted"},definitions[1]]})
  expect(deleted.status).toBe(200);expect(deleted.body.browserBindings).toEqual([{browser:1,reason:"missing"}])
  const projects=(yield* call("/api/orchestra/project")).body
  expect(projects.find((p:{id:string})=>p.id===test3.id).main).toBe(test3.main)
}))
