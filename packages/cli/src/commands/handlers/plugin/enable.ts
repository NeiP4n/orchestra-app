import { EOL } from "node:os"
import path from "node:path"
import { readFile, rename, writeFile } from "node:fs/promises"
import { Effect } from "effect"
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser"
import { Global } from "@orchestra/util/global"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { Config } from "../../../config"
import { resolveConfigPath } from "../mcp/add"

export default Runtime.handler(
  Commands.commands.plugin.commands.enable,
  Effect.fn("cli.plugin.enable")(function* (input) {
    const global = yield* Global.Service
    const configPath = yield* Effect.promise(() => resolveConfigPath(global.config))
    const server = yield* Effect.promise(() => enablePluginConfig(configPath, input.package))
    const config = yield* Config.Service
    const info = yield* config.get()
    const tui = configured(info.plugins, input.package)
    if (tui) {
      yield* config.update((draft) => {
        draft.plugins = draft.plugins?.map((entry) => {
          if (matches(entry, input.package)) {
            return typeof entry === "string" && entry.startsWith("-") ? entry.slice(1) : entry
          }
          return entry
        })
      })
    }

    const enabled = [server ? configPath : undefined, tui ? config.path : undefined].filter(
      (file) => file !== undefined,
    )
    process.stdout.write(
      enabled.length
        ? `Plugin "${input.package}" enabled in ${enabled.join(", ")}${EOL}`
        : `Plugin "${input.package}" is already enabled${EOL}`,
    )
  }),
)

export async function enablePluginConfig(configPath: string, spec: string) {
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
  const updatedPlugins = list.map((entry) => {
    if (matches(entry, spec)) {
      if (typeof entry === "string" && entry.startsWith("-")) {
        changed = true
        return entry.slice(1)
      }
    }
    return entry
  })

  // If not found in config at all, add it as enabled
  if (!list.some((entry) => matches(entry, spec))) {
    updatedPlugins.push(spec)
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

export function matches(entry: unknown, spec: string) {
  if (entry === spec) return true
  if (typeof entry === "string") {
    const raw = entry.startsWith("-") ? entry.slice(1) : entry
    if (raw === spec) return true
    if (raw.endsWith("/" + spec) || raw.endsWith("\\" + spec)) return true
    if (path.basename(raw) === spec) return true
  }
  if (typeof entry === "object" && entry !== null && "package" in entry) {
    const pkg = (entry as { package: string }).package
    const raw = pkg.startsWith("-") ? pkg.slice(1) : pkg
    if (raw === spec || raw.endsWith("/" + spec) || raw.endsWith("\\" + spec)) return true
  }
  return false
}
