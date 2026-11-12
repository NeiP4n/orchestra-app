/** @jsxImportSource @opentui/solid */
import { expect } from "bun:test"
import { mkdir, readFile } from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import { onCleanup } from "solid-js"
import { Global } from "@orchestra/util/global"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { ProjectTemplateTransfer } from "../../core/src/project-template-transfer"
import { ServerFetch } from "../../server/src/fetch"
import { Keymap } from "../src/context/keymap"
import { ProjectsProvider } from "../src/context/projects"
import { NotesProvider, useNotes } from "../src/context/notes"
import { RegistryPanel } from "../src/component/devtools-registry"
import { renderLocal } from "./fixture/local"

it.live("real mounted Templates saves and creates a project with auto chat, BrowserAgent and orchestrator rules", () => Effect.gen(function* () {
  const version = "1.0.0+85448456"
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
      const project = (yield* call("/api/orchestra/project", "POST", { name: "Test2", directory: source })).body
      const ordinary = (yield* call("/api/session", "POST", { title: "Приветствие auto", location: { directory: source } })).body.data
      const browser = (yield* call("/api/session", "POST", { title: "Whatsapp", agent: "team-browser-agent", location: { directory: source } })).body.data
      expect((yield* call("/api/orchestra/owner/" + browser.id, "PUT", { projectID: project.id })).status).toBe(204)
      expect((yield* call("/api/orchestra/rules/" + encodeURIComponent("orchestrator:" + project.id), "POST", { text: "Report failures and preserve the process." })).status).toBe(200)
      yield* Effect.promise(async () => {
        let seed: Promise<void>
        const seen: { route: string; status: number }[] = []
        const View = () => {
          const pop = Keymap.use().mode.push("modal")
          onCleanup(pop)
          seed = useNotes().importBrowserDefinitions({ importID: "pti_fixture", projectID: project.id, createdAt: 1, browsers: [{ id: "brw_fixture", name: "Whatsapp", chat: ordinary.id, mode: "window" }, { id: "brw_dedicated", name: "Dedicated", chat: browser.id, mode: "window" }] })
          return <RegistryPanel options={{ probe: () => true, terminalProbe: () => true, directory: source }} />
        }
        await using app = await renderLocal({
          language: "ru",
          fetch: async (url, request) => {
            if (url.pathname.startsWith("/api/orchestra/")) {
              const response = await handler(request)
              seen.push({ route: url.pathname, status: response.status })
              return response
            }
          },
          view: () => <ProjectsProvider><NotesProvider><View /></NotesProvider></ProjectsProvider>,
        })
        await seed!
        app.route.navigate({ type: "session", sessionID: project.main })
        app.renderer.start()
        const click = async (id: string) => {
          await app.waitFor(() => !!app.renderer.root.findDescendantById(id))
          const node = app.renderer.root.findDescendantById(id)!
          await app.mockMouse.click(node.x + 1, node.y)
          await app.renderOnce()
        }
        await app.waitForFrame(f => f.includes("Шаблоны"))
        const lines = app.captureCharFrame().split("\n"), row = lines.findIndex(line => line.includes("Шаблоны"))
        await app.mockMouse.click(lines[row].indexOf("Шаблоны") + 1, row)
        await click("project-templates.save")
        await app.waitForFrame(f => f.includes("Сохранить «Test2»"))
        await click("project-templates.confirm")
        await app.waitForFrame(f => f.includes("Проект сохранён"))
        const templates = (await call("/api/orchestra/project-template").pipe(Effect.runPromise)).body
        expect(templates).toHaveLength(1)
        await click("project-templates.create-" + templates[0].id)
        await app.waitForFrame(f => f.includes("Создать «Test2»"))
        await click("project-templates.confirm")
        await app.waitForFrame(f => f.includes("Проект создан"))
        if (process.env.CAPTURE_REAL_TEMPLATE_FRAME) await Bun.write(process.env.CAPTURE_REAL_TEMPLATE_FRAME, JSON.stringify(app.captureSpans()))
        expect(seen.every(r => r.status < 400)).toBe(true)
        expect(seen.map(r => r.route)).toContain("/api/orchestra/project-template/finish-create")
        const repeated=(await call("/api/orchestra/project-template/prepare-create","POST",{templateID:templates[0].id,settingsDirectory:source}).pipe(Effect.runPromise)).body
        expect((await call("/api/orchestra/project-template/confirm-create","POST",{token:repeated.token}).pipe(Effect.runPromise)).status).toBe(200)
        const projects = (await call("/api/orchestra/project").pipe(Effect.runPromise)).body
        expect(projects).toHaveLength(2)
        const paused=await call("/api/orchestra/project/"+project.id,"PATCH",{workEnabled:false}).pipe(Effect.runPromise)
        expect(paused.status).toBe(200);expect(paused.body.workEnabled).toBe(false)
        const independent=(await call("/api/orchestra/project").pipe(Effect.runPromise)).body
        expect(independent.find((p:{id:string})=>p.id===project.id).workEnabled).toBe(false)
        expect(independent.find((p:{id:string})=>p.id!==project.id).workEnabled).toBe(true)
        expect((await call("/api/orchestra/project/"+project.id,"PATCH",{workEnabled:true}).pipe(Effect.runPromise)).body.workEnabled).toBe(true)
        const created = projects.find((row: { id: string }) => row.id !== project.id)
        const sessions = (await call("/api/session?limit=100").pipe(Effect.runPromise)).body.data
        const auto = sessions.find((row: { id: string; title: string }) => row.id !== ordinary.id && row.title === ordinary.title)
        expect(auto).toBeDefined()
        expect(auto.agent).toBeUndefined()
        expect(auto.permissions).toEqual([])
        const rules = (await call("/api/orchestra/rules/" + encodeURIComponent("orchestrator:" + created.id)).pipe(Effect.runPromise)).body
        expect(rules.map((row: { text: string }) => row.text)).toContain("Report failures and preserve the process.")
        const notes = JSON.parse(await readFile(path.join(app.state, "test/tui/browser-sessions.json"), "utf8"))
        expect(notes.projects[created.id][0].name).toBe("Whatsapp")
        expect(notes.projects[created.id][0].id).not.toBe("brw_fixture")
        expect(notes.projects[created.id][0].chat).toBe(auto.id)
        expect(notes.projects[created.id][0].chat).not.toBe(ordinary.id)
        const importedBrowser = (await call("/api/session/" + notes.projects[created.id][0].chat).pipe(Effect.runPromise)).body.data
        expect(importedBrowser.agent).toBeUndefined()
        const dedicated = notes.projects[created.id].find((row: { name: string }) => row.name === "Dedicated")
        expect(dedicated.chat).not.toBe(browser.id)
        const importedDedicated = (await call("/api/session/" + dedicated.chat).pipe(Effect.runPromise)).body.data
        expect(importedDedicated.agent).toBe("team-browser-agent")
        // Reimport the exact exported file twice through the real API, not a UI adapter.
        const exported = (await call("/api/orchestra/project-template/export-file", "POST", {templateID:templates[0].id,projectID:project.id}).pipe(Effect.runPromise)).body
        for (let n=0;n<2;n++) {
          const pending=(await call("/api/orchestra/project-template/prepare-import","POST",{path: ' "'+exported.path+'" '}).pipe(Effect.runPromise)).body
          expect((await call("/api/orchestra/project-template/confirm-import","POST",{token:pending.token}).pipe(Effect.runPromise)).status).toBe(200)
        }
        expect((await call("/api/orchestra/project-template").pipe(Effect.runPromise)).body).toHaveLength(1)
        const copied=JSON.parse(await readFile(exported.path,"utf8"))
        copied.sessions[0].model={provider:"missing-fixture-provider",id:"unavailable-fixture",variant:null}
        const other=await ProjectTemplateTransfer.write(source,JSON.stringify(copied))
        const importPreview=(await call("/api/orchestra/project-template/prepare-import","POST",{path:other.path}).pipe(Effect.runPromise)).body
        const imported=(await call("/api/orchestra/project-template/confirm-import","POST",{token:importPreview.token}).pipe(Effect.runPromise)).body
        const rejected=await call("/api/orchestra/project-template/prepare-create","POST",{templateID:imported.id,settingsDirectory:source}).pipe(Effect.runPromise)
        expect(rejected.status).toBe(400)
        expect(rejected.body.kind).toBe("TEMPLATE_MODEL")
        expect(JSON.stringify(rejected.body)).not.toContain("missing-fixture-provider")
        const old=JSON.parse(await readFile(exported.path,"utf8"))
        old.process.roles.find((r:{agent:string})=>r.agent==="orchestrator").rules="Old server fingerprint"
        const build=old.process.roles.find((r:{agent:string})=>r.agent==="build")
        if(build?.runtime)build.runtime.system="Old built-in build system"
        const oldFile=await ProjectTemplateTransfer.write(source,JSON.stringify(old))
        const oldPreview=(await call("/api/orchestra/project-template/prepare-import","POST",{path:oldFile.path}).pipe(Effect.runPromise)).body
        const oldEntry=(await call("/api/orchestra/project-template/confirm-import","POST",{token:oldPreview.token}).pipe(Effect.runPromise)).body
        const blocked=await call("/api/orchestra/project-template/prepare-create","POST",{templateID:oldEntry.id,settingsDirectory:source}).pipe(Effect.runPromise)
        expect(blocked.body.kind).toBe("TEMPLATE_CORE_ROLE")
        const migration=await call("/api/orchestra/project-template/prepare-create","POST",{templateID:oldEntry.id,settingsDirectory:source,migrateCore:true}).pipe(Effect.runPromise)
        expect(migration.status).toBe(200)
        expect(migration.body.roleChanges.length).toBeGreaterThanOrEqual(1)
        expect(migration.body.roleChanges[0]).toMatchObject({role:"orchestrator",fields:["rules"]})
        expect(migration.body.roleChanges[0].fromHash).not.toBe(migration.body.roleChanges[0].toHash)
        expect(JSON.parse(migration.body.details).rules).toEqual(old.rules)
        expect((await call("/api/orchestra/project-template/confirm-create","POST",{token:migration.body.token}).pipe(Effect.runPromise)).status).toBe(200)
        expect(JSON.parse(await readFile(oldFile.path,"utf8"))).toEqual(old)
        const listed=(await call("/api/orchestra/project-template").pipe(Effect.runPromise)).body
        expect(new Set(listed.map((r:{digest:string})=>r.digest)).size).toBe(listed.length)
        const winPath=await call("/api/orchestra/project-template/prepare-create","POST",{templateID:templates[0].id,settingsDirectory:"C:\\Users\\Isako\\Desktop\\Test2"}).pipe(Effect.runPromise)
        if(process.platform!=="win32") { expect(winPath.status).toBe(400); expect(winPath.body.kind).toBe("TEMPLATE_PATH") }
        const toRemove=listed.find((r:{id:string})=>r.id===oldEntry.id)
        expect((await call("/api/orchestra/project-template/remove","POST",{templateID:toRemove.id,digest:toRemove.digest}).pipe(Effect.runPromise)).status).toBe(204)
        expect((await call("/api/orchestra/project-template").pipe(Effect.runPromise)).body.some((r:{id:string})=>r.id===oldEntry.id)).toBe(false)
        expect(JSON.parse(await readFile(oldFile.path,"utf8"))).toEqual(old)
        expect((await call("/api/orchestra/project").pipe(Effect.runPromise)).body.length).toBe(3)

      })
}), 30_000)
