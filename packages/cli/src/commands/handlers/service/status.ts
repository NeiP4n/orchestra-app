import { EOL } from "os"
import { Global } from "@orchestra/util/global"
import { Effect } from "effect"
import { Service } from "@orchestra/client/effect/service"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { ServiceConfig } from "../../../services/service-config"

export default Runtime.handler(
  Commands.commands.service.commands.status,
  Effect.fn("cli.service.status")(function* () {
    const options = yield* ServiceConfig.options()
    const found = yield* Service.discover({ ...options, version: undefined })
    process.stdout.write((found?.url ?? "stopped") + EOL)
    // The code the running server was started from (written at its start); a stale server shows an old commit.
    if (found?.url)
      yield* Effect.promise(async () => {
      try {
        const { readFileSync } = await import("node:fs")
        const info = JSON.parse(readFileSync(`${Global.Path.data}/server-build.json`, "utf8")) as { sha?: string; startedAt?: string }
        process.stdout.write(`code: ${info.sha ?? "unknown"}, started ${info.startedAt ?? "unknown"}` + EOL)
      } catch {
        process.stdout.write("code: unknown (this server started before the build file existed: restart it)" + EOL)
      }
      })
  }),
)
