import { copyFileSync, existsSync } from "node:fs"
import path from "node:path"
import { ORCHESTRA_CHANNEL } from "./version"

export function databasePath(data: string) {
  if (process.env.ORCHESTRA_DB) {
    const custom = process.env.ORCHESTRA_DB
    return custom === ":memory:" ? custom : path.resolve(data, custom)
  }

  const isDefaultChannel =
    ["latest", "dev", "beta", "next", "prod"].includes(ORCHESTRA_CHANNEL) ||
    ["1", "true"].includes(process.env.ORCHESTRA_DISABLE_CHANNEL_DB?.toLowerCase() ?? "")
  const suffix = isDefaultChannel ? "" : `-${ORCHESTRA_CHANNEL.replace(/[^a-zA-Z0-9._-]/g, "-")}`
  const primaryName = `orchestra${suffix}.db`
  const legacyName = `opencode${suffix}.db`

  const targetPath = path.resolve(data, primaryName)
  if (existsSync(targetPath)) {
    return targetPath
  }

  const legacyPath = path.resolve(data, legacyName)
  const legacyBase = path.resolve(data, "opencode.db")
  const sourceToMigrate = existsSync(legacyPath) ? legacyPath : existsSync(legacyBase) ? legacyBase : undefined

  if (sourceToMigrate) {
    try {
      copyFileSync(sourceToMigrate, targetPath)
      const wal = `${sourceToMigrate}-wal`
      if (existsSync(wal)) {
        copyFileSync(wal, `${targetPath}-wal`)
      }
      const shm = `${sourceToMigrate}-shm`
      if (existsSync(shm)) {
        copyFileSync(shm, `${targetPath}-shm`)
      }
      return targetPath
    } catch {
      return sourceToMigrate
    }
  }

  return targetPath
}
