import fs from "fs/promises"
import path from "path"
import { tmpdir } from "../test/fixture/tmpdir"

await using directory = await tmpdir("oc-")
const home = directory.path
const temporary = path.join(home, "tmp")
await fs.mkdir(temporary)

const environment = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(([name]) => {
      if (process.env.RECORD === "true" && name === "OPENAI_API_KEY") return true
      if (
        /^(?:AWS|AZURE|GOOGLE|GCP|GCLOUD|VERTEX|OPENAI|ANTHROPIC|GEMINI|XAI|CLOUDFLARE|CF_AIG|SNOWFLAKE|AICORE|GITLAB|NPM_CONFIG)_/i.test(
          name,
        )
      ) {
        return false
      }
      return !/(?:^|_)(?:API_KEY|AUTHORIZATION|TOKEN|SECRET|PASSWORD|CREDENTIALS?)$/i.test(name)
    }),
  ),
  HOME: home,
  ORCHESTRA_TEST_HOME: home,
  // Existing runner tests exercise the enforced ceilings. Enforcement is on by
  // default; the pin below only makes the test environment explicit.
  ORCHESTRA_ENFORCE_LIMITS: "1",
  // Tests match messages from git and other tools in English; a localized system would
  // otherwise translate them. Only messages change; the encoding and formats stay.
  LANGUAGE: "en",
  XDG_CONFIG_HOME: path.join(home, ".config"),
  XDG_DATA_HOME: path.join(home, ".local", "share"),
  XDG_CACHE_HOME: path.join(home, ".cache"),
  XDG_STATE_HOME: path.join(home, ".local", "state"),
  // Explicit app overrides win over XDG in Global.Path. Never inherit the
  // developer's roots, even when this launcher itself was started by Orchestra.
  ORCHESTRA_DATA_DIR: path.join(home, ".local", "share", "orchestra"),
  ORCHESTRA_CACHE_DIR: path.join(home, ".cache", "orchestra"),
  ORCHESTRA_STATE_DIR: path.join(home, ".local", "state", "orchestra"),
  ORCHESTRA_CONFIG_DIR: path.join(home, ".config", "orchestra"),
  // Bun initializes its runtime cache and os.homedir before a test preload.
  // Set these on the child process, not by mutating process.env in preload.
  BUN_RUNTIME_TRANSPILER_CACHE_PATH: path.join(home, ".cache", "bun", "transpiler"),
  ORCHESTRA_CONFIG: undefined,
  ORCHESTRA_CONFIG_CONTENT: undefined,
  TMPDIR: temporary,
  ...(process.platform === "win32" ? { USERPROFILE: home, TMP: temporary, TEMP: temporary } : {}),
}

const child = Bun.spawn({
  cmd: [process.execPath, "test", "--only-failures", ...process.argv.slice(2)],
  env: environment,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
})
const interrupt = () => child.kill("SIGINT")
const terminate = () => child.kill("SIGTERM")
process.once("SIGINT", interrupt)
process.once("SIGTERM", terminate)
const result = await child.exited
process.off("SIGINT", interrupt)
process.off("SIGTERM", terminate)

process.exitCode = result
