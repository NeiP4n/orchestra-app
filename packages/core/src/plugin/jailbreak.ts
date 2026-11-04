export * as JailbreakPlugin from "./jailbreak.js"

import { define } from "@orchestra/plugin/effect/plugin"
import { Mode } from "@orchestra/schema/mode"
import { Effect, Stream } from "effect"
import { Config } from "../config.js"
import type { Prompt } from "../jailbreak/catalog.js"

const mode = "jailbreak"

type Catalog = {
  readonly find: (id: string | undefined) => Prompt | undefined
  readonly match: (id: string | undefined) => Prompt | undefined
}

/**
 * Jailbreak is a work mode that is on out of the box, so it needs no config to appear or to work:
 * a session running the mode receives a bundled prompt with every request. Every bundled policy is
 * also a mode of its own (`jailbreak:<prompt id>`), which pins that policy for the session; the bare
 * `jailbreak` mode uses `jailbreak.prompt`, or the policy that fits the model when it is unset.
 * `jailbreak.enabled: false` turns the whole thing off. The modes sit next to the ordinary modes and
 * leave them, and the base prompt, alone.
 */
export const Plugin = define({
  id: "orchestra.jailbreak",
  effect: Effect.fn("JailbreakPlugin")(function* (ctx) {
    const config = yield* Config.Service

    // Loaded once the mode is usable: the catalog carries every bundled prompt.
    let bundled: Catalog | undefined
    let explicit: Prompt | undefined

    const load = Effect.fn("JailbreakPlugin.load")(function* () {
      const settings = Config.latest(yield* config.entries(), "jailbreak")
      if (settings?.enabled === false) {
        bundled = undefined
        explicit = undefined
        return
      }
      const module = yield* Effect.promise(() => import("../jailbreak.js"))
      bundled = module.Jailbreak
      if (settings?.prompt === undefined) {
        explicit = undefined
        return
      }
      explicit = bundled.find(settings.prompt)
      if (!explicit) return
      if (explicit.id !== settings.prompt) {
        yield* Effect.logWarning("unknown jailbreak prompt, falling back to the default", {
          prompt: settings.prompt,
          fallback: explicit.id,
        })
      }
    })

    yield* load()

    yield* ctx.session.hook("context", (event) =>
      Effect.gen(function* () {
        if (!bundled) return
        const session = yield* ctx.session.get({ sessionID: event.sessionID }).pipe(Effect.orDie)
        const selected = Mode.fromMetadata(session.metadata)
        if (!selected) return
        // Every bundled policy is its own mode (`jailbreak:<prompt id>`), so the session's mode can
        // name the policy directly. The bare `jailbreak` mode keeps the default: the prompt named in
        // config, otherwise the bundled one that fits the model.
        const pinned = Mode.jailbreakPromptID(String(selected.id))
        if (String(selected.id) !== mode && pinned === undefined) return
        const prompt = (pinned === undefined ? undefined : bundled.find(pinned)) ?? explicit ?? bundled.match(event.model?.id)
        if (!prompt) return
        event.system.push({ type: "text", text: prompt.text })
      }),
    )

    yield* ctx.event.subscribe().pipe(
      Stream.filter((event) => event.type === "config.updated"),
      Stream.runForEach(() =>
        load().pipe(Effect.catchCause((cause) => Effect.logWarning("failed to reload the Jailbreak mode", { cause }))),
      ),
      Effect.forkScoped({ startImmediately: true }),
    )
  }),
})
