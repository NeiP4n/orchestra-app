import path from "node:path"

const entrypoint = process.argv[1] ? path.resolve(process.argv[1]) : undefined

export function selfCommand() {
  const runtime = path.basename(process.execPath, path.extname(process.execPath)).toLowerCase()
  if (runtime !== "bun" && runtime !== "node" && runtime !== "nodejs") return [process.execPath]
  if (!entrypoint) throw new Error("Failed to resolve CLI entrypoint")
  if (runtime === "node" || runtime === "nodejs") return [process.execPath, ...nodeFlags(), entrypoint]
  return [process.execPath, ...bunFlags(), entrypoint]
}

// The checkout root when the CLI runs from source (`<root>/packages/cli/src/<entry>`),
// otherwise undefined (installed binary, bundled build). Spawned children —
// above all the background server — resolve their modules through Bun using
// the tsconfig in the working directory, so a source checkout's server must
// start from the checkout root, not from the caller's project directory.
export function selfRootFrom(entrypoint: string | undefined) {
  if (entrypoint === undefined) return undefined
  const src = path.dirname(entrypoint)
  if (path.basename(src) !== "src") return undefined
  const cli = path.dirname(src)
  if (path.basename(cli) !== "cli") return undefined
  const packages = path.dirname(cli)
  if (path.basename(packages) !== "packages") return undefined
  return path.dirname(packages)
}

export function selfRoot() {
  return selfRootFrom(entrypoint)
}

// A source checkout started from another directory finds its bunfig (and the JSX
// preload in it) only through --config; children start in the caller's directory
// too, so they need the same flag. A preload given by absolute path travels the
// same way, for launchers that start from a directory owning a foreign node_modules.
function bunFlags() {
  return process.execArgv.filter((arg) => arg.startsWith("--config=") || arg.startsWith("--preload="))
}

function nodeFlags() {
  return process.execArgv.flatMap((arg, index, args) => {
    if (index > 0 && args[index - 1] === "--conditions") return []
    if (arg === "--conditions") return args[index + 1] ? [arg, args[index + 1]] : []
    if (arg.startsWith("--conditions=")) return [arg]
    if (
      arg === "--experimental-ffi" ||
      arg === "--use-system-ca" ||
      arg === "--enable-source-maps" ||
      arg === "--no-addons"
    )
      return [arg]
    if (arg === "--no-warnings" || arg.startsWith("--disable-warning=")) return [arg]
    return []
  })
}
