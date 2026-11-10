export * as ProjectMetrics from "./metrics.js"

import { Flock } from "@orchestra/util/flock"
import { constants } from "node:fs"
import { lstat, mkdir, open, realpath } from "node:fs/promises"
import path from "node:path"
import { countSecrets } from "../memory/scrub.js"

export const MAX_BYTES = 10 * 1024 * 1024
export interface Receipt {
  projectID: string
  sessionID: string
  messageID: string
  providerID: string
  modelID: string
  at: number
  tokens: {
    input: number | null
    output: number | null
    reasoning: number | null
    cacheRead: number | null
    cacheWrite: number | null
  }
}
/** Explicit scalar projection only. Never serialize a session, request, error or provider metadata. */
export function encode(value: Receipt): string {
  const id = (value: string) => {
    if (typeof value !== "string" || !/^[A-Za-z0-9_./:-]{1,200}$/.test(value) || countSecrets(value))
      throw Error("Invalid metric identifier")
    return value
  }
  const number = (value: number | null) => {
    if (value !== null && (!Number.isSafeInteger(value) || value < 0)) throw Error("Invalid metric number")
    return value
  }
  if (value.at === null) throw Error("Metric time required")
  return (
    JSON.stringify({
      version: 1,
      type: "primary-usage",
      projectID: id(value.projectID),
      sessionID: id(value.sessionID),
      messageID: id(value.messageID),
      providerID: id(value.providerID),
      modelID: id(value.modelID),
      at: number(value.at),
      tokens: {
        input: number(value.tokens.input),
        output: number(value.tokens.output),
        reasoning: number(value.tokens.reasoning),
        cacheRead: number(value.tokens.cacheRead),
        cacheWrite: number(value.tokens.cacheWrite),
      },
    }) + "\n"
  )
}
/** Best-effort diagnostic sink, not billing. Caller owns project binding. No legacy/global fallback. */
export async function append(directory: string, receipt: Receipt) {
  const line = encode(receipt)
  const root = await realpath(directory)
  const own = path.join(root, ".orchestra")
  await mkdir(own, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error
  })
  const folder = await lstat(own)
  if (!folder.isDirectory() || folder.isSymbolicLink() || (await realpath(own)) !== own)
    throw Error("Metrics require a real project directory")
  const target = path.join(own, "metrics.jsonl")
  return Flock.withLock(
    target,
    async () => {
      const before = await lstat(target).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error
        return undefined
      })
      if (before && (before.isSymbolicLink() || !before.isFile())) throw Error("Metrics require a regular file")
      const handle = await open(
        target,
        constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
        0o600,
      )
      try {
        const info = await handle.stat()
        if (!info.isFile() || info.size + Buffer.byteLength(line) > MAX_BYTES) throw Error("Metrics file limit reached")
        await handle.writeFile(line, "utf8")
      } finally {
        await handle.close()
      }
    },
    { dir: path.join(own, ".metrics-locks") },
  )
}
