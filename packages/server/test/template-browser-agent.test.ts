import { expect } from "bun:test"
import path from "node:path"
import { writeFile } from "node:fs/promises"
import { Effect } from "effect"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { Global } from "@orchestra/util/global"
import { ServerFetch } from "../src/fetch"

for (const archived of [false, true])
  it.live(
    `BrowserAgent survives template save and reviewed create through the real HTTP handlers (${archived ? "QA archived bundle shape" : "new save"})`,
    () =>
      Effect.gen(function* () {
        const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("template-browser-http-")))
        const handler = yield* ServerFetch.make(
          {
            app: { version: "1.0.0" },
            database: { path: ":memory:" },
            fs: { filewatcher: false },
            models: { fetch: false },
            config: { directory: tmp.path, project: false, content: "{}" },
          },
          {
            allowUnauthenticated: true,
            overrides: [
              Global.node.replace(
                Global.layerWith({
                  data: path.join(tmp.path, "data"),
                  cache: path.join(tmp.path, "cache"),
                  config: path.join(tmp.path, "config"),
                  state: path.join(tmp.path, "state"),
                  tmp: path.join(tmp.path, "tmp"),
                  bin: path.join(tmp.path, "bin"),
                  log: path.join(tmp.path, "log"),
                  repos: path.join(tmp.path, "repos"),
                }),
              ),
            ],
          },
        )
        const call = (route: string, body?: unknown) =>
          Effect.promise(async () => {
            const response = await handler(
              new Request(`http://opencode.local/api${route}`, {
                method: body === undefined ? "GET" : "POST",
                headers: { "content-type": "application/json" },
                body: body === undefined ? undefined : JSON.stringify(body),
              }),
            )
            const text = await response.text()
            return { status: response.status, body: text ? JSON.parse(text) : undefined }
          })
        const project = yield* call("/orchestra/project", { name: "Browser source", directory: tmp.path })
        expect(project.status).toBe(200)
        const session = yield* call("/session", {
          title: "BrowserAgent",
          agent: "team-browser-agent",
          location: { directory: tmp.path },
        })
        expect(session.status).toBe(200)
        const browsers = [{ id: "brw_saved", name: "Saved browser", mode: "window", chat: session.body.data.id }]
        const saved = yield* call("/orchestra/project-template/prepare-save", { projectID: project.body.id, browsers })
        expect(saved.status).toBe(200)
        const bundle = JSON.parse(saved.body.details)
        expect(bundle.sessions.find((row: { title: string }) => row.title === "BrowserAgent").role).toBe(
          "team-browser-agent",
        )
        expect(
          (yield* call("/orchestra/project-template/confirm-save", { token: saved.body.token, browsers })).status,
        ).toBe(204)
        const templates = yield* call("/orchestra/project-template")
        let templateID = templates.body[0].id
        if (archived) {
          // QA supplied this archived shape, not the original serialized role rules.
          // Use the exported core definitions unchanged; do not invent the missing bytes.
          bundle.name = "QA SeriesA TemplateSave"
          bundle.minOrchestraVersion = "1.0.0+cfe2f963b"
          bundle.sessions[1].title = "Browser 1"
          bundle.browsers[0].name = "Browser 1"
          bundle.rules = [
            { scope: "project", session: null, text: "Check the result." },
            { scope: "project", session: null, text: "Keep project boundaries." },
            { scope: "orchestrator", session: null, text: "Delegate browser work." },
          ]
          const file = path.join(tmp.path, "qa-archived.orchestra-template")
          yield* Effect.promise(() => writeFile(file, JSON.stringify(bundle)))
          const reviewed = yield* call("/orchestra/project-template/prepare-import", { path: file })
          expect(reviewed.status).toBe(200)
          const importedFile = yield* call("/orchestra/project-template/confirm-import", { token: reviewed.body.token })
          expect(importedFile.status).toBe(200)
          templateID = importedFile.body.id
        }
        const prepared = yield* call("/orchestra/project-template/prepare-create", {
          templateID,
          settingsDirectory: tmp.path,
        })
        expect(prepared.status).toBe(200)
        const created = yield* call("/orchestra/project-template/confirm-create", { token: prepared.body.token })
        expect({ status: created.status, kind: created.body?.kind }).toEqual({ status: 200, kind: undefined })
        expect(created.body.browsers.browsers).toHaveLength(1)
        expect((yield* call("/orchestra/project-template/finish-create", { token: prepared.body.token })).status).toBe(
          204,
        )
        const imported = yield* call(`/session/${created.body.browsers.browsers[0].chat}`)
        expect(imported.body.data.agent).toBe("team-browser-agent")
      }).pipe(Effect.scoped),
    30_000,
  )
