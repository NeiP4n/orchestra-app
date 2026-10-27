import { EOL } from "node:os"
import { readFile, rename, writeFile } from "node:fs/promises"
import { Effect } from "effect"
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser"
import { Global } from "@orchestra/util/global"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { Config } from "../../../config"
import { resolveConfigPath } from "../mcp/add"
import { matches } from "./enable"

export default Runtime.handler(
  Commands.commands.plugin.commands.disable,
  Effect.fn("cli.plugin.disable")(function* (input) {
    const global = yield* Global.Service
    const configPath = yield* Effect.promise(() => resolveConfigPath(global.config))
    const server = yield* Effect.promise(() => disablePluginConfig(configPath, input.package))
    const config = yield* Config.Service
    const info = yield* config.get()
    const tui = configured(info.plugins, input.package)
    if (tui) {
      yield* config.update((draft) => {
        draft.plugins = draft.plugins?.map((entry) => {
          if (matches(entry, input.package)) {
            if (typeof entry === "string") return entry.startsWith("-") ? entry : `-${entry}`
            if (typeof entry === "object" && entry !== null && "package" in entry) return `-${entry.package}`
          }
          return entry
        })
      })
    }

    const disabled = [server ? configPath : undefined, tui ? config.path : undefined].filter(
      (file) => file !== undefined,
    )
    process.stdout.write(
      disabled.length
        ? `Plugin "${input.package}" disabled in ${disabled.join(", ")}${EOL}`
        : `Plugin "${input.package}" is already disabled${EOL}`,
    )
  }),
)

export async function disablePluginConfig(configPath: string, spec: string) {
  const text = await readFile(configPath, "utf8").catch((error) => {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined
    throw error
  })
  if (text === undefined) return false
  const errors: ParseError[] = []
  const config: unknown = parse(text, errors, { allowTrailingComma: true })
  if (errors.length || typeof config !== "object" || config === null || Array.isArray(config))
    throw new Error(`Invalid global configuration: ${configPath}`)
  const plugins = "plugins" in config ? config.plugins : undefined
  if (plugins !== undefined && !Array.isArray(plugins)) throw new Error(`Invalid plugins configuration: ${configPath}`)

  const list = plugins ?? []
  let changed = false
  let found = false
  const updatedPlugins = list.map((entry) => {
    if (matches(entry, spec)) {
      found = true
      if (typeof entry === "string") {
        if (!entry.startsWith("-")) {
          changed = true
          return `-${entry}`
        }
        return entry
      }
      if (typeof entry === "object" && entry !== null && "package" in entry) {
        changed = true
        return `-${entry.package}`
      }
    }
    return entry
  })

  // If not found in config, append -<spec> to disable it
  if (!found) {
    updatedPlugins.push(`-${spec}`)
    changed = true
  }

  if (!changed) return false

  const updated = applyEdits(
    text,
    modify(text, ["plugins"], updatedPlugins, {
      formattingOptions: { tabSize: 2, insertSpaces: true },
    }),
  )
  const temporary = configPath + ".tmp"
  await writeFile(temporary, updated.endsWith("\n") ? updated : updated + "\n", { mode: 0o600 })
  await rename(temporary, configPath)
  return true
}

function configured(plugins: readonly unknown[] | undefined, spec: string) {
  return plugins?.some((entry) => matches(entry, spec)) ?? false
}
