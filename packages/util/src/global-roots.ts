import os from "os"
import path from "path"
import fs from "fs"

const home = os.homedir()
const data = process.env.XDG_DATA_HOME || (home ? path.join(home, ".local", "share") : undefined)
const cache = process.env.XDG_CACHE_HOME || (home ? path.join(home, ".cache") : undefined)
const config = process.env.XDG_CONFIG_HOME || (home ? path.join(home, ".config") : undefined)
const state = process.env.XDG_STATE_HOME || (home ? path.join(home, ".local", "state") : undefined)

function resolveWithFallback(base: string | undefined, primary: string, fallback: string) {
  if (!base) return undefined
  const primaryPath = path.join(base, primary)
  if (fs.existsSync(primaryPath)) return primaryPath
  const fallbackPath = path.join(base, fallback)
  if (fs.existsSync(fallbackPath)) return fallbackPath
  return primaryPath
}

/** The XDG base directories that root orchestra's global paths, falling back to opencode. */
export function roots(app: string) {
  const fallbackApp = app === "orchestra" ? "opencode" : app
  return {
    data: resolveWithFallback(data, app, fallbackApp) ?? path.join(data!, app),
    cache: resolveWithFallback(cache, app, fallbackApp) ?? path.join(cache!, app),
    config: resolveWithFallback(config, app, fallbackApp) ?? path.join(config!, app),
    state: resolveWithFallback(state, app, fallbackApp) ?? path.join(state!, app),
    tmp: path.join(os.tmpdir(), app),
  }
}
