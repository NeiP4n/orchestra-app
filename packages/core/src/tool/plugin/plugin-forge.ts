export * as PluginForgeTool from "./plugin-forge.js"

import { ToolFailure } from "@orchestra/ai"
import type { Context } from "@orchestra/plugin/effect/plugin"
import { Effect, Schema } from "effect"
import { Config } from "../../config.js"

export const name = "plugin_forge"
export const command = "forge-plugin"

const description = [
  "Manage Orchestra plugins dynamically in the plugin registry and configuration.",
  "Actions: list shows all active, disabled, and configured plugins with their status;",
  "add registers/configures a new plugin package or specifier;",
  "remove unregisters/removes a plugin from configuration;",
  "enable re-enables a disabled plugin in configuration;",
  "disable disables a plugin in configuration (marking it inactive with '-' prefix without removing).",
].join("\n")

export const Input = Schema.Struct({
  action: Schema.Literals(["list", "add", "remove", "enable", "disable"]),
  package: Schema.optionalKey(Schema.String).annotate({
    description: "Plugin package specifier, module path, or plugin ID (required for add, remove, enable, disable)",
  }),
})

export const Output = Schema.Struct({ output: Schema.String })

function matchesTarget(entry: unknown, target: string): boolean {
  if (entry === target) return true
  if (typeof entry === "string") {
    const raw = entry.startsWith("-") ? entry.slice(1) : entry
    if (raw === target) return true
    if (raw.endsWith(`/${target}`) || raw.endsWith(`\\${target}`)) return true
  }
  if (typeof entry === "object" && entry !== null && "package" in entry) {
    const pkg = (entry as { package: string }).package
    const raw = pkg.startsWith("-") ? pkg.slice(1) : pkg
    if (raw === target || raw.endsWith(`/${target}`) || raw.endsWith(`\\${target}`)) return true
  }
  return false
}

export const Plugin = {
  id: "orchestra.tool.plugin-forge",
  effect: Effect.fn("PluginForgeTool.Plugin")(function* (ctx: Context) {
    const config = yield* Config.Service

    const getConfiguredPlugins = Effect.fnUntraced(function* () {
      const entries = yield* config.entries()
      return Config.latest(entries, "plugins") ?? []
    })

    const updatePlugins = Effect.fnUntraced(function* (next: readonly (string | { package: string })[]) {
      if (!config.update) {
        return yield* new ToolFailure({
          message: "This runtime cannot write the configuration, so plugin settings cannot be saved.",
        })
      }
      yield* config.update({ plugins: next as any }).pipe(
        Effect.mapError((error) => new ToolFailure({ message: error.message, error })),
      )
    })

    yield* ctx.tool
      .transform((editor) =>
        editor.add({
          name,
          options: { codemode: false },
          description,
          input: Input,
          output: Output,
          execute: (input) =>
            Effect.gen(function* () {
              const configured = yield* getConfiguredPlugins()

              if (input.action === "list") {
                const rows: Array<{ id: string; status: string; source: string }> = []

                for (const entry of configured) {
                  const target = typeof entry === "string" ? entry : entry.package
                  const disabled = target.startsWith("-")
                  const raw = disabled ? target.slice(1) : target
                  rows.push({
                    id: raw,
                    status: disabled ? "disabled" : "active",
                    source: raw,
                  })
                }

                if (rows.length === 0) {
                  return { output: { output: "No plugins are configured." } }
                }

                const lines = rows.map((r) => `- [${r.status}] ${r.id} (source: ${r.source})`)
                return {
                  output: {
                    output: ["Installed and configured plugins:", ...lines].join("\n"),
                  },
                }
              }

              const target = input.package?.trim()
              if (!target) {
                return yield* new ToolFailure({
                  message: `Action "${input.action}" requires the "package" argument (package specifier or ID).`,
                })
              }

              if (input.action === "add") {
                const already = configured.some((entry) => matchesTarget(entry, target))
                if (already) {
                  const next = configured.map((entry) => {
                    if (matchesTarget(entry, target)) {
                      return typeof entry === "string" && entry.startsWith("-") ? entry.slice(1) : entry
                    }
                    return entry
                  })
                  yield* updatePlugins(next)
                  return { output: { output: `Plugin "${target}" is already in configuration (ensured enabled).` } }
                }
                yield* updatePlugins([...configured, target])
                return { output: { output: `Plugin "${target}" added to configuration.` } }
              }

              if (input.action === "remove") {
                const next = configured.filter((entry) => !matchesTarget(entry, target))
                yield* updatePlugins(next)
                return { output: { output: `Plugin "${target}" removed from configuration.` } }
              }

              if (input.action === "enable") {
                let found = false
                const next = configured.map((entry) => {
                  if (matchesTarget(entry, target)) {
                    found = true
                    return typeof entry === "string" && entry.startsWith("-") ? entry.slice(1) : entry
                  }
                  return entry
                })
                if (!found) {
                  next.push(target)
                }
                yield* updatePlugins(next)
                return { output: { output: `Plugin "${target}" enabled in configuration.` } }
              }

              if (input.action === "disable") {
                let found = false
                const next = configured.map((entry) => {
                  if (matchesTarget(entry, target)) {
                    found = true
                    if (typeof entry === "string") return entry.startsWith("-") ? entry : `-${entry}`
                    if (typeof entry === "object" && entry !== null && "package" in entry) {
                      return `-${entry.package}`
                    }
                  }
                  return entry
                })
                if (!found) {
                  next.push(`-${target}`)
                }
                yield* updatePlugins(next)
                return { output: { output: `Plugin "${target}" disabled in configuration.` } }
              }

              return yield* new ToolFailure({ message: `Unknown action: ${input.action}` })
            }),
        }),
      )
  }),
}
