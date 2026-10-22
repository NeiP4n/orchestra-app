import { Effect, Layer } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { AppNodeBuilder } from "@orchestra/core/effect/app-node-builder"
import { LayerNode } from "@orchestra/util/effect/layer-node"
import { Credential } from "@orchestra/core/credential"
import { Config } from "@orchestra/core/config"
import { Bus } from "@orchestra/core/bus"
import { Form } from "@orchestra/core/form"
import { Integration } from "@orchestra/core/integration"
import { WebSearch } from "@orchestra/core/websearch"
import { testEffect } from "../lib/effect"

interface WebSearchRequest {
  readonly url: string
  readonly headers: Record<string, string>
  readonly body: unknown
}

export const requests: WebSearchRequest[] = []
export const signals: AbortSignal[] = []
let responseBody = ""
let responseStatus = 200

export function resetWebSearchFixture(body: string, status = 200) {
  requests.length = 0
  signals.length = 0
  responseBody = body
  responseStatus = status
}

const http = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request, _url, signal) =>
    Effect.sync(() => {
      signals.push(signal)
      if (request.body._tag !== "Uint8Array") throw new Error(`Unexpected request body: ${request.body._tag}`)
      requests.push({
        url: request.url,
        headers: request.headers,
        body: JSON.parse(new TextDecoder().decode(request.body.body)),
      })
      return HttpClientResponse.fromWeb(request, new Response(responseBody, { status: responseStatus }))
    }),
  ),
)

export const webSearchIntegrationTest = testEffect(
  Layer.merge(
    AppNodeBuilder.build(LayerNode.group([Integration.node, Credential.node, Bus.node, Form.node, WebSearch.node]), [
      Config.node.replace(Config.testLayer()),
    ]),
    http,
  ),
)
