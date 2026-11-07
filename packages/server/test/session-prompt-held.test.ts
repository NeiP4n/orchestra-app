import { expect, setDefaultTimeout } from "bun:test"
import { Bus } from "@orchestra/core/bus"
import { Session } from "@orchestra/core/session"
import { SessionExecution } from "@orchestra/core/session/execution"
import { SessionHold } from "@orchestra/core/session/hold"
import { SessionMessage } from "@orchestra/core/session/message"
import { makeGlobalNode } from "@orchestra/util/effect/app-node"
import { Effect, Layer } from "effect"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { ServerFetch } from "../src/fetch"

setDefaultTimeout(30_000)

it.live("reports a held session in the prompt response instead of staying silent", () =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-session-prompt-held-")))
    const execution = Layer.effect(
      SessionExecution.Service,
      Effect.succeed(
        SessionExecution.Service.of({
          active: Effect.succeed(new Set()),
          isActive: () => Effect.succeed(false),
          resume: () => Effect.void,
          wake: () => Effect.void,
          interrupt: () => Effect.succeed(false),
          awaitIdle: () => Effect.void,
        }),
      ),
    )
    const handler = yield* ServerFetch.make(
      {
        app: { version: "test-version" },
        database: { path: ":memory:" },
        fs: { filewatcher: false },
        models: { fetch: false },
      },
      {
        allowUnauthenticated: true,
        overrides: [
          SessionExecution.node.replace(
            makeGlobalNode({ service: SessionExecution.Service, layer: execution, deps: [Bus.node] }),
          ),
        ],
      },
    )
    const request = (path: string, body?: unknown) =>
      Effect.promise(async () => {
        const response = await handler(
          new Request(`http://opencode.local${path}`, {
            method: body === undefined ? "GET" : "POST",
            headers: body === undefined ? undefined : { "content-type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body),
          }),
        )
        return { status: response.status, body: (await response.json()) as Record<string, unknown> }
      })
    const create = (directory: string) => request("/api/session", { location: { directory } })
    const held = yield* create(tmp.path)
    const heldID = Session.ID.make((held.body.data as { id: string }).id)
    const running = yield* create(tmp.path)
    const runningID = Session.ID.make((running.body.data as { id: string }).id)
    // The hold predicate is scoped to this one session, so no other test's
    // session in this file is affected by installing it.
    SessionHold.install((sessionID) => Effect.succeed(sessionID === heldID))

    const paused = yield* request(`/api/session/${heldID}/prompt`, { id: SessionMessage.ID.create(), text: "hello" })
    expect(paused.status).toBe(200)
    expect(paused.body.held).toBe(true)
    expect((paused.body.data as { id: string }).id).toBeDefined()

    const admitted = yield* request(`/api/session/${runningID}/prompt`, {
      id: SessionMessage.ID.create(),
      text: "hello",
    })
    expect(admitted.status).toBe(200)
    expect(admitted.body.held).toBe(false)
  }),
)

it.live("admits a vague human prompt instead of rejecting it", () =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-session-prompt-vague-")))
    const execution = Layer.effect(
      SessionExecution.Service,
      Effect.succeed(
        SessionExecution.Service.of({
          active: Effect.succeed(new Set()),
          isActive: () => Effect.succeed(false),
          resume: () => Effect.void,
          wake: () => Effect.void,
          interrupt: () => Effect.succeed(false),
          awaitIdle: () => Effect.void,
        }),
      ),
    )
    const handler = yield* ServerFetch.make(
      {
        app: { version: "test-version" },
        database: { path: ":memory:" },
        fs: { filewatcher: false },
        models: { fetch: false },
      },
      {
        allowUnauthenticated: true,
        overrides: [
          SessionExecution.node.replace(
            makeGlobalNode({ service: SessionExecution.Service, layer: execution, deps: [Bus.node] }),
          ),
        ],
      },
    )
    const request = (path: string, body?: unknown) =>
      Effect.promise(async () => {
        const response = await handler(
          new Request(`http://opencode.local${path}`, {
            method: body === undefined ? "GET" : "POST",
            headers: body === undefined ? undefined : { "content-type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body),
          }),
        )
        return { status: response.status, body: (await response.json()) as Record<string, unknown> }
      })
    const created = yield* request("/api/session", { location: { directory: tmp.path } })
    const sessionID = Session.ID.make((created.body.data as { id: string }).id)

    // A vague prompt from a human used to come back as PromptRejectedError
    // ("Prompt rejected: Промпт расплывчатый...") and never reach the model.
    // It is admitted now: the clarify verdict and its questions ride in the
    // intake metadata, and the model asks the user in chat instead.
    const vague = yield* request(`/api/session/${sessionID}/prompt`, {
      id: SessionMessage.ID.create(),
      text: "сделай что-нибудь",
    })
    expect(vague.status).toBe(200)
    const payload = (vague.body.data as { payload: { text: string; metadata?: { intake?: Record<string, unknown> } } })
      .payload
    expect(payload.text).toBe("сделай что-нибудь")
    expect(payload.metadata?.intake).toMatchObject({ verdict: "clarify", trivial: false })
    expect((payload.metadata?.intake?.questions as Array<string> | undefined)?.length).toBeGreaterThan(0)
  }),
)
