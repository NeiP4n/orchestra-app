import path from "node:path"
import os from "node:os"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { setDefaultTimeout } from "bun:test"
import { rgPath } from "@vscode/ripgrep"

// Core tests boot real sessions, databases and federation rounds; the 5s bun default times the same
// files out on a loaded machine and passes them on an idle one. Bun has no bunfig key for this, so
// the budget is raised here, once, for every test file: 30s per test, not per file.
setDefaultTimeout(30_000)

// Preload runs before application modules capture XDG defaults. Never read or write the
// developer's memory, browser bridge, config or profiles while running unit tests.
// Override inherited app roots too: XDG alone cannot override ORCHESTRA_DATA_DIR.
const home = mkdtempSync(path.join(os.tmpdir(), "orchestra-core-test-"))
const roots = {
  data: path.join(home, ".local", "share"),
  cache: path.join(home, ".cache"),
  config: path.join(home, ".config"),
  state: path.join(home, ".local", "state"),
}
process.env.HOME = home
process.env.USERPROFILE = home
process.env.ORCHESTRA_TEST_HOME = home
for (const [kind, root] of Object.entries(roots)) {
  process.env[`XDG_${kind.toUpperCase()}_HOME`] = root
  process.env[`ORCHESTRA_${kind.toUpperCase()}_DIR`] = path.join(root, "orchestra")
  mkdirSync(path.join(root, "orchestra"), { recursive: true })
}
const tmp = path.join(home, "tmp")
mkdirSync(tmp, { recursive: true })
for (const key of ["TMPDIR", "TMP", "TEMP"]) process.env[key] = tmp
for (const key of [
  "ORCHESTRA_CONFIG",
  "ORCHESTRA_CONFIG_CONTENT",
  "AWS_REGION",
  "GOOGLE_VERTEX_PROJECT",
  "NPM_CONFIG_REGISTRY",
  "UIDOTSH_AUTHORIZATION",
]) delete process.env[key]
if (process.env.RECORD !== "true") delete process.env.OPENAI_API_KEY
process.once("exit", () => {
  // Windows may still have a test database open during process shutdown.
  try {
    rmSync(home, { recursive: true, force: true })
  } catch {}
})

process.env.ORCHESTRA_DB = ":memory:"
process.env.NPM_CONFIG_AUDIT = "false"
// MCP is off by default for agents; the MCP machinery tests need it on.
process.env.ORCHESTRA_MCP = "1"

// Keep ripgrep integration tests offline: use the binary shipped with the
// test dependency rather than triggering the application's first-run download.
const pathKey = process.platform === "win32" && "Path" in process.env ? "Path" : "PATH"
process.env[pathKey] = [path.dirname(rgPath), process.env[pathKey]].filter(Boolean).join(path.delimiter)
