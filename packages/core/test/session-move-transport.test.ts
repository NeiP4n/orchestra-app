import { describe, expect } from "bun:test"
import path from "path"
import { mkdir, rm } from "fs/promises"
import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { LLM } from "@orchestra/ai"
import { LLMClient, RequestExecutor } from "@orchestra/ai/route"
import { configure } from "@orchestra/ai/providers/openai"
import { AppNodeBuilder } from "@orchestra/core/effect/app-node-builder"
import { Bus } from "@orchestra/core/bus"
import { Database } from "@orchestra/core/database/database"
import { Location } from "@orchestra/core/location"
import { AbsolutePath } from "@orchestra/core/schema"
import { Project } from "@orchestra/core/project"
import { Session } from "@orchestra/core/session"
import { SessionExecution } from "@orchestra/core/session/execution"
import { SessionModelTransport } from "@orchestra/core/session/model-transport"
import { SessionProjector } from "@orchestra/core/session/projector"
import { SessionStore } from "@orchestra/core/session/store"
import { LayerNode } from "@orchestra/util/effect/layer-node"
import { testEffect } from "./lib/effect"
import { globalProjectNode } from "./lib/project"
import { offlineModels } from "./fixture/models"
import { tmpdirScoped } from "./fixture/tmpdir"
import { makeWebSocketServer } from "./lib/websocket-server"
import { WebSocketConstructor } from "../src/effect/websocket-constructor"

// The transport the SessionMove service closes and the transport this test
// drives are the same instance: the node is replaced with the real layer.
const appLayer = AppNodeBuilder.build(
  LayerNode.group([Database.node, Bus.node, SessionProjector.node, SessionStore.node, Session.node, SessionModelTransport.node]),
  [
    Project.node.replace(globalProjectNode),
    SessionExecution.node.replace(SessionExecution.noopLayer),
    offlineModels,
    SessionModelTransport.node.replace(
      SessionModelTransport.layer.pipe(Layer.provide(WebSocketConstructor.layer)),
    ),
  ],
)
const runtime = Layer.mergeAll(
  appLayer,
  LLMClient.layer.pipe(Layer.provide(RequestExecutor.layer), Layer.provide(FetchHttpClient.layer)),
)
const it = testEffect(runtime)

describe("Session.move transport lifecycle", () => {
  it.live("an immediate recovery move resets a session pinned to HTTP fallback", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const source = AbsolutePath.make(path.join(tmp.path, "source"))
      const destination = AbsolutePath.make(path.join(tmp.path, "destination"))
      yield* Effect.promise(() => Promise.all([mkdir(source), mkdir(destination)]))

      let allowUpgrade = false
      let attempts = 0
      const http: Array<unknown> = []
      const server = yield* makeWebSocketServer({
        upgrade: () => {
          attempts++
          return allowUpgrade
        },
        async http(request) {
          http.push(await request.json())
          return new Response(
            `data: ${JSON.stringify({
              type: "response.completed",
              response: {
                id: "resp_http",
                output: [
                  { type: "message", id: "msg_http", role: "assistant", content: [{ type: "output_text", text: "http" }] },
                ],
                usage: { input_tokens: 10, output_tokens: 1 },
              },
            })}\n\n`,
            { headers: { "content-type": "text/event-stream" } },
          )
        },
        message(socket, message) {
          const body = JSON.parse(message.toString())
          const id = `resp_ws_${server.state.opens}`
          const item = {
            type: "message",
            id: `msg_ws_${server.state.opens}`,
            role: "assistant",
            content: [{ type: "output_text", text: "ws" }],
          }
          socket.send(JSON.stringify({ type: "response.created", response: { id } }))
          socket.send(JSON.stringify({ type: "response.output_item.added", output_index: 0, item }))
          socket.send(JSON.stringify({ type: "response.output_item.done", output_index: 0, item }))
          socket.send(JSON.stringify({ type: "response.completed", response: { id, output: [item] } }))
          void body
        },
      })
      const request = LLM.request({
        model: configure({
          apiKey: "test",
          baseURL: server.url.replace(/^ws/, "http").replace(/responses$/, ""),
          headers: { "x-test": "move-transport" },
        }).responses("fixture"),
        prompt: "Hello",
        promptCacheKey: "move-transport",
      })

      const session = yield* Session.Service
      const transport = yield* SessionModelTransport.Service
      const created = yield* session.create({ location: Location.Ref.make({ directory: source }) })
      const webSocket = transport.bind(created.id)

      // The upgrade is refused: the exchange completes over HTTP and the
      // transport pins the session to the HTTP fallback.
      yield* LLMClient.generate(request, { webSocket })
      expect(http).toHaveLength(1)
      expect(attempts).toBe(1)
      expect(server.state.opens).toBe(0)

      // The pin holds for the next exchange: no new WebSocket attempt.
      yield* LLMClient.generate(request, { webSocket })
      expect(http).toHaveLength(2)
      expect(attempts).toBe(1)

      // Recovery: the source directory vanishes and the user picks another
      // directory — the immediate steer move the recovery UI sends.
      yield* Effect.promise(() => rm(source, { recursive: true }))
      yield* session.move({ sessionID: created.id, directory: destination })
      expect((yield* session.get(created.id)).location.directory).toBe(destination)

      // With upgrades allowed again, the next exchange must initialize a
      // fresh WebSocket transport instead of inheriting the fallback pin.
      allowUpgrade = true
      yield* LLMClient.generate(request, { webSocket })
      expect(attempts).toBe(2)
      expect(server.state.opens).toBe(1)
      expect(http).toHaveLength(2)
    }),
  )
})
