import path from "node:path"
import { ORCHESTRA_CHANNEL } from "./version"

export function databasePath(data: string) {
  const filename =
    process.env.ORCHESTRA_DB ??
    (["latest", "dev", "beta", "next", "prod"].includes(ORCHESTRA_CHANNEL) ||
    process.env.ORCHESTRA_DISABLE_CHANNEL_DB === "1" ||
    process.env.ORCHESTRA_DISABLE_CHANNEL_DB === "true"
      ? "opencode.db"
      : `opencode-${ORCHESTRA_CHANNEL.replace(/[^a-zA-Z0-9._-]/g, "-")}.db`)
  return filename === ":memory:" ? filename : path.resolve(data, filename)
}
