import { expect } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import { Global } from "@orchestra/util/global"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { ServerFetch } from "../src/fetch"

it.live(
  "project template HTTP flow captures configuration, confirms once, and creates fresh inert real stores",
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
          app: { version: "1.0.0" },
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
      const browsers = [{ id: "brw_source", name: "Inbox", chat: browserAgent.id, mode: "window" }]
      const prepared = yield* call("/api/orchestra/project-template/prepare-save", "POST", {
        projectID: project.id,
        browsers,
      })
      expect(prepared.status).toBe(200)
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
      const main = (yield* call("/api/session/" + created.body.mainSessionID)).body.data
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
      expect(
        (yield* call("/api/orchestra/project-template/prepare-save", "POST", {
          projectID: project.id,
          browsers: [{ ...browsers[0], chat: created.body.mainSessionID }],
        })).status,
      ).toBe(400)
      expect(
        (yield* call("/api/orchestra/project-template/confirm-create", "POST", { token: "../foreign" })).status,
      ).toBe(400)
    }),
  30_000,
)
