import { EOL } from "node:os"
import path from "node:path"
import { readFile } from "node:fs/promises"
import { parse } from "jsonc-parser"
import { Effect } from "effect"
import { OpenCode, type PluginInfo } from "@orchestra/client"
import { Service } from "@orchestra/client/effect/service"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { ServerConnection } from "../../../services/server-connection"
import { Config } from "../../../config"
import { Global } from "@orchestra/util/global"
import { Npm } from "@orchestra/util/npm"
import { Host } from "@orchestra/plugin/host"
import { categorizePlugin, PLUGIN_CATEGORIES } from "@orchestra/plugin/category"
import { fileURLToPath } from "node:url"
import { discoverPluginTargets, localPluginDirectories, localSource } from "@orchestra/tui/plugin/discovery"
import { resolveConfigPath } from "../mcp/add"

export default Runtime.handler(
  Commands.commands.plugin.commands.list,
  Effect.fn("cli.plugin.list")(function* (input) {
    const { endpoint } = yield* ServerConnection.resolve()
    const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) })
    const response = yield* Effect.promise(() => client.plugin.list({ location: { directory: process.cwd() } }))
    const config = yield* Config.Service
    const global = yield* Global.Service
    const info = yield* config.get()
    const discovered = yield* Effect.promise(() =>
      localPluginDirectories(process.cwd(), global.config).then(discoverPluginTargets),
    )
    const npm = yield* Npm.Service
    const configured = yield* Effect.forEach([...(info.plugins ?? []), ...discovered], (entry) =>
      Effect.gen(function* () {
        const target = typeof entry === "string" ? entry : entry.package
        if (
          target.startsWith("-") ||
          target === "*" ||
          target.endsWith(".*") ||
          target.startsWith("orchestra.") ||
          target.startsWith("opencode.")
        )
          return []
        const local = localSource(target, path.dirname(config.path))
        if (local) {
          const directory = fileURLToPath(local)
          const entrypoints = Host.resolve({ directory })
          return entrypoints.tui ? [{ target: directory, version: "local" }] : []
        }
        if (!(yield* Effect.promise(() => Npm.isInstallablePackage(target)))) return []
        const installed = yield* npm.resolve(target)
        if (!Host.resolve(installed).tui) return []
        return [{ target, version: installed.version }]
      }),
    )

    const configPath = yield* Effect.promise(() => resolveConfigPath(global.config))
    const globalPlugins = yield* Effect.promise(() =>
      readFile(configPath, "utf8")
        .then((text) => {
          const parsed = parse(text)
          return Array.isArray(parsed?.plugins) ? (parsed.plugins as unknown[]) : []
        })
        .catch(() => []),
    )
    const disabledTargets = [...(info.plugins ?? []), ...globalPlugins]
      .filter((entry): entry is string => typeof entry === "string" && entry.startsWith("-"))
      .map((entry) => entry.slice(1))

    const output = format(response.data, configured.flat(), input.builtin, disabledTargets)
    if (!output) {
      process.stdout.write("No plugins found" + EOL)
      return
    }
    process.stdout.write(output + EOL)
  }),
)

const norm = (p: string) =>
  p
    .replace(/\\/g, "/")
    .toLowerCase()
    .replace(/\/index\.(?:[cm]?[jt]s|json)$/, "")
    .replace(/\/$/, "")

export function format(
  plugins: readonly PluginInfo[],
  tui: ReadonlyArray<{ readonly target: string; readonly version?: string }>,
  builtin = false,
  disabled: readonly string[] = [],
) {
  const isTargetDisabled = (id: string, target: string) =>
    disabled.some((d) => {
      const nd = norm(d)
      const nt = norm(target)
      return d === id || nd === nt || nt.startsWith(nd) || nt.endsWith("/" + nd) || nd.endsWith("/" + id)
    })

  const server = plugins
    .filter((plugin) => builtin || plugin.source.type !== "builtin")
    .map((plugin) => {
      const id = plugin.id ?? "-"
      const target =
        plugin.source.type === "package"
          ? plugin.source.target
          : plugin.source.type === "local"
            ? plugin.source.path
            : plugin.source.type
      const disabledState = isTargetDisabled(id, target)
      const status = disabledState ? "disabled" : plugin.state?.status === "failed" ? "failed" : "active"
      return {
        id,
        status,
        version:
          plugin.source.type === "package"
            ? (plugin.source.version ?? "-")
            : plugin.source.type === "local"
              ? "local"
              : "-",
        target,
        category: categorizePlugin(id !== "-" ? id : undefined, target),
      }
    })

  const targets = tui
    .filter(
      (item) =>
        !server.some((s) => norm(s.target) === norm(item.target) || norm(s.target).startsWith(norm(item.target))),
    )
    .filter((plugin, index, all) => all.findIndex((candidate) => candidate.target === plugin.target) === index)
    .map((plugin) => ({
      id: "-",
      status: isTargetDisabled("-", plugin.target) ? "disabled" : "active",
      version: plugin.version ?? "-",
      target: plugin.target,
      category: categorizePlugin(undefined, plugin.target),
    }))

  const disabledRows = disabled
    .filter(
      (item) =>
        !server.some((s) => isTargetDisabled(s.id, s.target)) &&
        !targets.some((t) => isTargetDisabled("-", t.target)),
    )
    .filter((item, index, all) => all.indexOf(item) === index)
    .map((item) => ({
      id: path.basename(item),
      status: "disabled",
      version: "-",
      target: item,
      category: categorizePlugin(path.basename(item), item),
    }))

  const allItems = [...server, ...targets, ...disabledRows]
  if (!allItems.length) return ""

  const categoriesPresent = PLUGIN_CATEGORIES.filter((cat) => allItems.some((item) => item.category === cat))
  const extraCategories = Array.from(
    new Set(allItems.map((item) => item.category).filter((cat) => !PLUGIN_CATEGORIES.includes(cat))),
  )
  const orderedCategories = [...categoriesPresent, ...extraCategories]

  const sections: string[] = []

  for (const category of orderedCategories) {
    const categoryItems = allItems
      .filter((item) => item.category === category)
      .toSorted((a, b) => a.id.localeCompare(b.id) || a.target.localeCompare(b.target))

    if (!categoryItems.length) continue

    const rows = categoryItems.map((item) => [
      item.id,
      item.status,
      /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(item.version) ? item.version.slice(0, 7) : item.version,
      item.target,
    ])

    const table = [["ID", "STATUS", "VERSION", "SOURCE"], ...rows]
    const widths = [0, 1, 2].map((index) => Math.max(...table.map((row) => row[index].length)))
    const renderedTable = table
      .map((row) => `${row[0].padEnd(widths[0])}  ${row[1].padEnd(widths[1])}  ${row[2].padEnd(widths[2])}  ${row[3]}`)
      .join(EOL)

    sections.push(`[${category}]${EOL}${renderedTable}`)
  }

  return sections.join(`${EOL}${EOL}`)
}
