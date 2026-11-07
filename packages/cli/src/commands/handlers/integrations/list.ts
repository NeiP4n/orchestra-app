import { EOL } from "node:os"
import { Effect } from "effect"
import { ProjectFilesIntegrations } from "@orchestra/core/project-files/files-integrations"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"

/** `orchestra integrations list` — the installed manifests of this project, one per line. Read-only. */
export default Runtime.handler(
  Commands.commands.integrations.commands.list,
  Effect.fn("cli.integrations.list")(function* () {
    const installed = yield* ProjectFilesIntegrations.listIntegrations(process.cwd())
    if (installed.length === 0) {
      process.stdout.write(`No integrations installed in this project.${EOL}`)
      return
    }
    process.stdout.write(
      [...installed.map((manifest) => `${manifest.name}\t${manifest.kind}\t${manifest.description}`), ``].join(EOL),
    )
  }),
)
