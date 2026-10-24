import { describe, expect, test } from "bun:test"
import {
  AIError,
  ContentPolicyError,
  InvalidRequestError,
  ProviderInternalError,
  QuotaExceededError,
  RateLimitError,
} from "@orchestra/ai"
import { Model } from "@orchestra/schema/model"
import { Provider } from "@orchestra/schema/provider"
import { SessionRunnerLLM } from "@orchestra/core/session/runner/llm"

const model = (input: string) => Model.Ref.parse(input)
const current = model("opencode/big-pickle")
const next = model("zen/glm-4.6")
const spare = model("opencode/minimax-free")

const failure = (reason: ConstructorParameters<typeof AIError>[0]["reason"]) => new AIError({ reason })

const fallback = (input: { cause: AIError; models?: ReadonlyArray<Model.Ref>; refused?: ReadonlyArray<Model.Ref> }) =>
  SessionRunnerLLM.fallbackModel({
    cause: input.cause,
    models: input.models ?? [next, spare],
    current,
    refused: new Set((input.refused ?? []).map((item) => `${item.providerID}/${item.id}#${item.variant ?? ""}`)),
  })

describe("SessionRunnerLLM.fallbackModel", () => {
  test("leaves a failure the retry policy can wait out to it", () => {
    const cause = failure(new ProviderInternalError({ message: "internal" }))
    expect(fallback({ cause })).toBeUndefined()
  })

  test("continues on the next model when the provider rejects the request outright", () => {
    const cause = failure(new InvalidRequestError({ message: "User location is not supported" }))
    expect(fallback({ cause })).toEqual(next)
  })

  test("continues on the next model when the address spent its free tier", () => {
    const cause = failure(
      new RateLimitError({
        message: "Rate limit exceeded. Please try again later.",
        body: JSON.stringify({ type: "error", error: { type: "FreeUsageLimitError", message: "Rate limit exceeded." } }),
      }),
    )
    expect(fallback({ cause })).toEqual(next)
    expect(fallback({ cause, models: [spare] })).toEqual(spare)
  })

  test("keeps an ordinary rate limit on the retry policy", () => {
    expect(fallback({ cause: failure(new RateLimitError({ message: "Too many requests" })) })).toBeUndefined()
  })

  test("does not dodge a content policy refusal with another model", () => {
    const cause = failure(new ContentPolicyError({ message: "The request was blocked by the provider's policy" }))
    expect(fallback({ cause })).toBeUndefined()
    expect(fallback({ cause, models: [next, spare] })).toBeUndefined()
  })

  test("does not hide a context overflow that survived compaction behind another model", () => {
    const cause = failure(
      new InvalidRequestError({ message: "This model's maximum context length is 128000 tokens", classification: "context-overflow" }),
    )
    expect(fallback({ cause })).toBeUndefined()
    expect(fallback({ cause, models: [next, spare] })).toBeUndefined()
  })

  test("returns nothing when the session carries no fallback models", () => {
    const cause = failure(new InvalidRequestError({ message: "User location is not supported" }))
    expect(fallback({ cause, models: [] })).toBeUndefined()
  })

  test("skips the current model and every model that already refused", () => {
    const cause = failure(
      new QuotaExceededError({
        message: "Rate limit exceeded.",
        body: JSON.stringify({ error: { type: "FreeUsageLimitError" } }),
      }),
    )
    expect(fallback({ cause, models: [current, next], refused: [next] })).toBeUndefined()
    expect(fallback({ cause, models: [current, spare, next], refused: [next] })).toEqual(spare)
    expect(fallback({ cause, models: [next, spare], refused: [next] })).toEqual(
      Model.Ref.make({ providerID: Provider.ID.make("opencode"), id: Model.ID.make("minimax-free") }),
    )
  })
})
