import path from "node:path"
import { existsSync, copyFileSync } from "node:fs"
import { ORCHESTRA_CHANNEL } from "./version"

export function databasePath(data: string) {
  const filename =
    process.env.ORCHESTRA_DB ??
    process.env.OPENCODE_DB ??
    (["latest", "dev", "beta", "next", "prod"].includes(ORCHESTRA_CHANNEL) ||
    process.env.ORCHESTRA_DISABLE_CHANNEL_DB === "1" ||
    process.env.ORCHESTRA_DISABLE_CHANNEL_DB === "true" ||
    process.env.OPENCODE_DISABLE_CHANNEL_DB === "1" ||
    process.env.OPENCODE_DISABLE_CHANNEL_DB === "true"
      ? "orchestra-local.db"
      : `orchestra-${ORCHESTRA_CHANNEL.replace(/[^a-zA-Z0-9._-]/g, "-")}.db`)
  if (filename === ":memory:") return filename
  const target = path.resolve(data, filename)
  if (!existsSync(target)) {
    const legacyNames = [
      "opencode-local.db",
      "opencode.db",
      filename.replace(/^orchestra-/, "opencode-").replace(/^orchestra\./, "opencode."),
    ]
    const legacy = legacyNames.map((name) => path.resolve(data, name)).find((p) => existsSync(p))
    if (legacy) {
      try {
        copyFileSync(legacy, target)
        if (existsSync(`${legacy}-wal`)) copyFileSync(`${legacy}-wal`, `${target}-wal`)
        if (existsSync(`${legacy}-shm`)) copyFileSync(`${legacy}-shm`, `${target}-shm`)
      } catch {
        return legacy
      }
    }
  }
  return target
}
