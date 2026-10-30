export * as ConfigContextGovernorPlugin from "./context-governor.js"

import { define } from "@orchestra/plugin/effect/plugin"
import type { Entry } from "@orchestra/schema/config"
import { Effect } from "effect"
import { Config } from "../../config.js"
import { SessionContextGovernor } from "../../session/context-governor.js"
import { ConfigEntryObserver } from "./entry-observer.js"

export const Plugin = define({
  id: "opencode.config.context-governor",
  effect: Effect.fn(function* (ctx) {
    const config = yield* Config.Service
    const apply = (entries: readonly Entry[]) =>
      SessionContextGovernor.configure(Config.latest(entries, "experimental")?.context_governor === true)
    const loaded = yield* ConfigEntryObserver.observe(
      config,
      ctx.event,
      config.entries().pipe(Effect.flatMap((entries) => Effect.sync(() => apply(entries)))),
    )
    apply(loaded.entries)
  }),
})
