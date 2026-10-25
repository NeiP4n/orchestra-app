import { Effect } from "effect"
import { define } from "@orchestra/plugin/effect/plugin"

export const KiloPlugin = define({
  id: "opencode.provider.kilo",
  effect: Effect.fn(function* (ctx) {
    yield* ctx.provider.transform((evt) => {
      for (const item of evt.list()) {
        if (item.provider.package !== "@orchestra/ai/providers/openai-compatible") continue
        if (item.provider.settings?.baseURL !== "https://api.kilo.ai/api/gateway") continue
        evt.update(item.provider.id, (provider) => {
          provider.headers = {
            ...provider.headers,
            "HTTP-Referer": "https://github.com/NeiP4n/orchestra-app",
            "X-Title": "orchestra",
          }
        })
      }
    })
  }),
})
