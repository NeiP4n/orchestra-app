import { Effect, Option } from "effect"
import { Commands } from "../commands"
import { Runtime } from "../../framework/runtime"
import { readConfig, runGateway } from "../../gateway"

export default Runtime.handler(
  Commands.commands.gateway,
  Effect.fnUntraced(function* (input) {
    const env: Record<string, string | undefined> = { ...process.env }
    // Optional flags arrive as Options; only the ones given override the environment.
    const set = (name: string, value: Option.Option<string | number>) =>
      Option.match(value, { onNone: () => undefined, onSome: (given) => (env[name] = String(given)) })
    set("ORCHESTRA_GATEWAY_HOST", input.host)
    set("ORCHESTRA_GATEWAY_PORT", input.port)
    set("ORCHESTRA_GATEWAY_UPSTREAM_URL", input.upstream)
    set("ORCHESTRA_GATEWAY_MODEL", input.model)
    if (input.fallbackModel.length) env.ORCHESTRA_GATEWAY_FALLBACK_MODELS = input.fallbackModel.join(",")
    set("ORCHESTRA_GATEWAY_ROOM_API_URL", input.roomApiUrl)
    set("ORCHESTRA_GATEWAY_ROOM_ID", input.roomId)

    let config: ReturnType<typeof readConfig>
    try {
      config = readConfig(env)
    } catch (error) {
      return yield* Effect.fail(new Error(error instanceof Error ? error.message : String(error)))
    }

    return yield* Effect.promise(() => runGateway(config))
  }),
)
