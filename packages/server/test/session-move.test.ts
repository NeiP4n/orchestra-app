import { expect } from "bun:test"
import { mkdir, rm } from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { ServerFetch } from "../src/fetch"

// End-to-end coverage of the recovery endpoint the clients call:
// POST /api/session/:sessionID/move — real handler, real services, real
// HTTP-shaped requests (complements the Core Session.move test, which
// bypasses the API layer).
it.live(
  "recovers a session over HTTP after its directory disappears",
  () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-session-move-http-")))
      const source = path.join(tmp.path, "source")
      const destination = path.join(tmp.path, "destination")
      yield* Effect.promise(() => Promise.all([mkdir(source), mkdir(destination)]))
      const handler = yield* ServerFetch.make({
        app: { version: "test" },
        // Simulation mode: prompt execution completes against the built-in
        // simulated model, so running the recovered session needs no network.
        simulation: true,
        database: { path: ":memory:" },
        fs: { filewatcher: false },
        models: { fetch: false },
        config: { directory: tmp.path, project: false, content: "{}" },
      })
      const call = (route: string, method = "GET", body?: unknown) =>
        Effect.promise(async () => {
          const response = await handler(
            new Request(`http://opencode.local${route}`, {
              method,
              headers: { "content-type": "application/json" },
              body: body === undefined ? undefined : JSON.stringify(body),
            }),
          )
          const text = await response.text()
          return { status: response.status, body: text ? JSON.parse(text) : undefined }
        })

      // A session in directory A with a user message admitted through the
      // public prompt endpoint (resume: false — admitted, not executed, so
      // the session is idle exactly as a restored session would be).
      const created = yield* call("/api/session", "POST", { title: "Recovery", location: { directory: source } })
      expect(created.status).toBe(200)
      const sessionID = created.body.data.id as string
      expect(created.body.data.location.directory).toBe(source)
      const seeded = yield* call(`/api/session/${sessionID}/prompt`, "POST", {
        text: "before the move",
        resume: false,
      })
      expect(seeded.status).toBe(200)

      // Directory A disappears — the screenshot condition.
      yield* Effect.promise(() => rm(source, { recursive: true }))

      // The recovery call itself, exactly as the clients send it.
      const moved = yield* call(`/api/session/${sessionID}/move`, "POST", { directory: destination })
      expect(moved.status).toBe(204)

      // Same session, now persisted at directory B.
      const after = yield* call(`/api/session/${sessionID}`)
      expect(after.status).toBe(200)
      expect(after.body.data.id).toBe(sessionID)
      expect(after.body.data.location.directory).toBe(destination)

      // The pre-move message survived the relocation (still admitted work
      // for the same session, not lost with the old location).
      const inbox = yield* call(`/api/session/${sessionID}/inbox`)
      expect(
        (inbox.body.data as Array<{ type: string; payload?: { text?: string } }>).map((item) => item.payload?.text),
      ).toContain("before the move")

      // The session remains usable: a new prompt wakes execution at B and
      // both messages land in the same session's history.
      const prompted = yield* call(`/api/session/${sessionID}/prompt`, "POST", { text: "after the move" })
      expect(prompted.status).toBe(200)
      const texts = yield* Effect.gen(function* () {
        for (let attempt = 0; attempt < 100; attempt++) {
          const history = yield* call(`/api/session/${sessionID}/message`)
          const found = (history.body.data as Array<{ type: string; text?: string }>)
            .map((message) => message.text)
            .filter((text) => text !== undefined)
          if (found.includes("before the move") && found.includes("after the move")) return found
          yield* Effect.sleep("200 millis")
        }
        return [] as string[]
      })
      expect(texts).toContain("before the move")
      expect(texts).toContain("after the move")

      // A move to a missing directory is a typed client error, not a 500,
      // and does not mutate the session.
      const invalid = yield* call(`/api/session/${sessionID}/move`, "POST", {
        directory: path.join(tmp.path, "does-not-exist"),
      })
      expect(invalid.status).toBe(400)
      expect((yield* call(`/api/session/${sessionID}`)).body.data.location.directory).toBe(destination)
    }),
  { timeout: 30_000 },
)
