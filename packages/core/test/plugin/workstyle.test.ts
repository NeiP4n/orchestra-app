import { describe, expect } from "bun:test"
import { Effect } from "effect"
import type { SessionContext } from "@orchestra/plugin/effect/session"
import { Agent } from "@orchestra/core/agent"
import { Model } from "@orchestra/core/model"
import { Provider } from "@orchestra/core/provider"
import { Session } from "@orchestra/core/session"
import { OptimizePlugin } from "@orchestra/core/plugin/optimize"
import { it } from "../lib/effect"
import { host } from "./host"

const context = (model: string) =>
  ({
    sessionID: Session.ID.make("ses_workstyle"),
    agent: Agent.ID.make("TeamLead"),
    model: Model.Ref.make({ id: Model.ID.make(model), providerID: Provider.ID.make("opencode") }),
    system: [{ type: "text", text: "Agent prompt" }],
    messages: [],
    options: {},
    tools: {},
  }) as unknown as SessionContext

const install = Effect.gen(function* () {
  let hook: ((input: SessionContext) => Effect.Effect<void>) | undefined
  yield* OptimizePlugin.WorkstylePlugin.effect(
    host({
      session: {
        hook: (name, callback) => {
          if (name === "context") hook = callback as (input: SessionContext) => Effect.Effect<void>
          return Effect.succeed({ dispose: Effect.void })
        },
      },
    }),
  )
  return hook!
})

describe("workstyle prompt", () => {
  it.effect("reaches untuned models even under an agent's own prompt", () =>
    Effect.gen(function* () {
      const hook = yield* install
      const event = context("space-bunny-free")
      yield* hook(event)
      expect(event.system.map((part) => part.text)).toEqual([
        "Agent prompt",
        expect.stringContaining("# Working fast"),
      ])
    }),
  )

  it.effect("adds the shared principles for every model", () =>
    Effect.gen(function* () {
      let hook: ((input: SessionContext) => Effect.Effect<void>) | undefined
      yield* OptimizePlugin.PrinciplesPlugin.effect(
        host({
          session: {
            hook: (name, callback) => {
              if (name === "context") hook = callback as (input: SessionContext) => Effect.Effect<void>
              return Effect.succeed({ dispose: Effect.void })
            },
          },
        }),
      )
      for (const model of ["claude-opus-5-5", "gpt-5.2", "space-bunny-free"]) {
        const event = context(model)
        yield* hook!(event)
        expect(event.system.map((part) => part.text)).toEqual([
          "Agent prompt",
          expect.stringContaining("# Ground rules"),
        ])
      }
    }),
  )

  it.effect("leaves Claude and GPT models alone", () =>
    Effect.gen(function* () {
      const hook = yield* install
      for (const model of ["claude-opus-5-5", "gpt-5.2"]) {
        const event = context(model)
        yield* hook(event)
        expect(event.system).toHaveLength(1)
      }
    }),
  )
})
