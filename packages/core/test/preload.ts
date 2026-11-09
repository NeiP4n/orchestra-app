import path from "node:path"
import { setDefaultTimeout } from "bun:test"
import { rgPath } from "@vscode/ripgrep"

// Core tests boot real sessions, databases and federation rounds; the 5s bun default times the same
// files out on a loaded machine and passes them on an idle one. Bun has no bunfig key for this, so
// the budget is raised here, once, for every test file: 30s per test, not per file.
setDefaultTimeout(30_000)

process.env.ORCHESTRA_DB = ":memory:"
process.env.NPM_CONFIG_AUDIT = "false"
// MCP is off by default for agents; the MCP machinery tests need it on.
process.env.ORCHESTRA_MCP = "1"

// Keep ripgrep integration tests offline: use the binary shipped with the
// test dependency rather than triggering the application's first-run download.
const pathKey = process.platform === "win32" && "Path" in process.env ? "Path" : "PATH"
process.env[pathKey] = [path.dirname(rgPath), process.env[pathKey]].filter(Boolean).join(path.delimiter)
