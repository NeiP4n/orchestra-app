import { constants, openSync, closeSync, fstatSync, readFileSync, lstatSync } from "node:fs"
import path from "node:path"
export const oauthClientFile = () => path.join(process.cwd(), ".orchestra", "credentials.env")
const names = new Set(["ORCHESTRA_ANTIGRAVITY_CLIENT_ID", "ORCHESTRA_ANTIGRAVITY_CLIENT_SECRET"])
/** Local-only, bounded dotenv subset. No shell, expansion, imports, logging or env mutation. */
export function oauthClientEnvironment(env: NodeJS.ProcessEnv = process.env, file = oauthClientFile()): NodeJS.ProcessEnv {
  let fd: number | undefined
  try {
    if(lstatSync(path.dirname(file)).isSymbolicLink())throw Error("Local OAuth directory must not be a link.")
    const stat = lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 16384) throw Error("Invalid local OAuth credentials file.")
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const opened = fstatSync(fd)
    if (opened.ino !== stat.ino || opened.dev !== stat.dev) throw Error("Local OAuth credentials file changed.")
    const values: NodeJS.ProcessEnv = {}
    for (const line of readFileSync(fd, "utf8").split(/\r?\n/)) {
      const value = line.trim()
      if (!value || value.startsWith("#")) continue
      const match = /^(ORCHESTRA_ANTIGRAVITY_CLIENT_(?:ID|SECRET))\s*=\s*(.*)$/.exec(value)
      if (!match || !names.has(match[1]!)) throw Error("Invalid local OAuth credentials file format.")
      let content = match[2]!.trim()
      if ((content.startsWith('"') && content.endsWith('"')) || (content.startsWith("'") && content.endsWith("'"))) content = content.slice(1, -1)
      values[match[1]!] = content
    }
    return { ...values, ...env }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return env
    // File contents, OS errors and values never cross this boundary.
    throw Error("Could not read local .orchestra/credentials.env. Check its format and permissions.")
  } finally { if (fd !== undefined) closeSync(fd) }
}

/** Fixed instructions only. Never interpolate a value from the environment/file. */
export const oauthClientSetupHint = "From the Orchestra launch folder in cmd.exe run: bun script/init-oauth-client.mjs && notepad .orchestra\\credentials.env . Enter the OAuth application's matching CLIENT_ID and CLIENT_SECRET locally, save, then fully restart Orchestra from that folder. Do not send or commit secrets. Alternatively set ORCHESTRA_ANTIGRAVITY_CLIENT_SECRET in the launch terminal before starting Orchestra."
