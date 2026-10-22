import path from "node:path"
import { rgPath } from "@vscode/ripgrep"

process.env.ORCHESTRA_DB = ":memory:"
process.env.NPM_CONFIG_AUDIT = "false"

// Keep ripgrep integration tests offline: use the binary shipped with the
// test dependency rather than triggering the application's first-run download.
const pathKey = process.platform === "win32" && "Path" in process.env ? "Path" : "PATH"
process.env[pathKey] = [path.dirname(rgPath), process.env[pathKey]].filter(Boolean).join(path.delimiter)
