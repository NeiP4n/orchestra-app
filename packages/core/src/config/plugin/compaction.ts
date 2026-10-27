export * as ConfigCompactionPlugin from "./compaction.js"

import { define } from "@orchestra/plugin/effect/plugin"
import { Effect } from "effect"
import { Config } from "../../config.js"
import { SessionCompaction } from "../../session/compaction.js"
import { ConfigEntryObserver } from "./entry-observer.js"

export const Plugin = define({
  id: "opencode.config.compaction",
  effect: Effect.fn(function* (ctx) {
    const config = yield* Config.Service
    const compaction = yield* SessionCompaction.Service
    const loaded = yield* ConfigEntryObserver.observe(config, ctx.event, compaction.reload())
    yield* compaction.transform((editor) => {
      for (const entry of loaded.entries) {
        if (entry.type !== "document" || !entry.info.compaction) continue
        editor.configure({
          ...(entry.info.compaction.auto === undefined ? {} : { auto: entry.info.compaction.auto }),
          ...(entry.info.compaction.buffer === undefined ? {} : { buffer: entry.info.compaction.buffer }),
          ...(entry.info.compaction.threshold === undefined
            ? {}
            : {
                threshold: SessionCompaction.parseCompactionThreshold(entry.info.compaction.threshold),
                thresholdPercent: undefined,
              }),
          ...(entry.info.compaction.threshold_percent === undefined
            ? {}
            : { thresholdPercent: entry.info.compaction.threshold_percent }),
          ...(entry.info.compaction.keep_free_percent === undefined
            ? {}
            : { keepFreePercent: entry.info.compaction.keep_free_percent }),
          ...(entry.info.compaction.keep?.tokens === undefined ? {} : { keep: entry.info.compaction.keep.tokens }),
        })
      }
    })
  }),
})
