export * as ProjectDebug from "./project-debug.js"

import path from "node:path"
import { constants } from "node:fs"
import { lstat, mkdir, open, readFile, rename } from "node:fs/promises"
import { redactSecrets } from "./secret-redaction.js"

export const eventTypes = new Set(["session.inbox.enqueued", "session.synthetic", "session.text.ended", "session.tool.called", "session.tool.success", "session.tool.failed", "session.shell.started", "session.shell.ended", "session.execution.started", "session.execution.failed", "session.execution.interrupted", "session.step.ended", "session.step.failed", "session.retry.scheduled", "session.usage.recorded", "session.usage.updated"])

export const MAX_BYTES = 10 * 1024 * 1024
const REDACTED = "[redacted]"
const sensitive = /(?:key|secret|token|password|passwd|authorization|cookie|credential)/i
export const logPath = (directory: string) => path.join(directory, ".orchestra", "project-debug.jsonl")
const settingsPath = (directory: string) => path.join(directory, ".orchestra", "debug-recording.json")
const errors = new Map<string, string>()
const locks = new Map<string, Promise<void>>()

/** Redact structured fields, known secret environment values and credential shapes before disk IO. */
// Only the exact numeric token-usage schema is diagnostic data, never a token
// credential. Extra fields or string values remain secret-bearing and redacted.
const usageCounters = (value: unknown): boolean => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const row = value as { [key: string]: unknown }
  if (Object.keys(row).sort().join(",") !== "cache,input,output,reasoning") return false
  if (![row.input,row.output,row.reasoning].every(value => typeof value === "number" && Number.isFinite(value))) return false
  const cache = row.cache as { [key: string]: unknown } | undefined
  return !!cache && Object.keys(cache).sort().join(",") === "read,write" &&
    [cache.read,cache.write].every(value => typeof value === "number" && Number.isFinite(value))
}
export function redact(value: unknown, environment: NodeJS.ProcessEnv = process.env): unknown {
  const secrets = Object.entries(environment).filter(([key, value]) => sensitive.test(key) && value && value.length >= 1).map(([, value]) => value!)
  const clean = (value: unknown, depth = 0): unknown => {
    if (depth > 30) return "[depth limit]"
    if (typeof value === "string") {
      let text = value
      for (const secret of secrets) text = text.split(secret).join(REDACTED)
      text = redactSecrets(text).replace(/((?:--)(?:[\w-]*(?:key|secret|token|password|passwd)[\w-]*)\s+)(?:"[^"\n]*"|'[^'\n]*'|[^\s]+)/gi, `$1${REDACTED}`)
      return text.replace(/((?:[A-Za-z_][\w-]*(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD)[\w-]*)["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;}]+)/gi, `$1${REDACTED}`)
        .replace(/((?:authorization|proxy-authorization|cookie|set-cookie)["']?\s*:\s*)[^\r\n]+/gi, `$1${REDACTED}`)
    }
    if (Array.isArray(value)) return value.map((item) => clean(item, depth + 1))
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sensitive.test(key) && !(key === "tokens" && usageCounters(item)) ? REDACTED : clean(item, depth + 1)]))
    return value
  }
  return clean(value)
}

async function noLink(file: string) {
  try { const info = await lstat(file); if (info.isSymbolicLink() || (!info.isDirectory() && info.nlink > 1)) throw Error("Debug recording refuses symbolic links or hard links") }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
}
async function directoryReady(directory: string) {
  const folder = path.dirname(logPath(directory))
  await noLink(folder)
  await mkdir(folder, { recursive: true, mode: 0o700 })
  const ignore = path.join(folder, ".gitignore")
  await noLink(ignore)
  let text = ""
  try { text = await readFile(ignore, "utf8") } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
  const original = text
  for (const name of ["project-debug.jsonl", "project-debug.jsonl.1", "debug-recording.json"]) if (!text.split(/\r?\n/).includes(name)) text += `${text && !text.endsWith("\n") ? "\n" : ""}${name}\n`
  if (text !== original) {
    await replacePrivateFile(ignore, text)
  }
  return folder
}
// O_TRUNC mutates at open, before the descriptor can be checked. Open first,
// validate the exact object, and only then truncate, chmod and replace its text.
async function replacePrivateFile(file: string, text: string) {
  const before = await lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error
    return undefined
  })
  if (before && (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1))
    throw Error("Debug recording requires a private regular file")
  const handle = await open(file, constants.O_WRONLY | (before ? 0 : constants.O_CREAT | constants.O_EXCL) | (constants.O_NOFOLLOW ?? 0), 0o600)
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.nlink !== 1 || (before && (before.ino !== info.ino || before.dev !== info.dev)))
      throw Error("Debug recording requires an unchanged private regular file")
    await handle.truncate(0)
    await handle.chmod(0o600)
    await handle.writeFile(text)
  } finally { await handle.close() }
}

export async function enabled(directory: string): Promise<boolean> {
  await noLink(path.dirname(settingsPath(directory)))
  await noLink(settingsPath(directory))
  try { return JSON.parse(await readFile(settingsPath(directory), "utf8")).enabled === true }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
  return process.env.ORCHESTRA_PROJECT_DEBUG === "1"
}
export async function setEnabled(directory: string, value: boolean) {
  await directoryReady(directory)
  await noLink(settingsPath(directory))
  await replacePrivateFile(settingsPath(directory), JSON.stringify({ enabled: value }) + "\n")

}

export function failed(directory: string) { errors.set(logPath(directory), "Recording failed. Check the backend log and project path permissions.") }
export async function status(directory: string) {
  const file = logPath(directory)
  const isEnabled = await enabled(directory)
  await noLink(file)
  let bytes = 0, lastWrite: number | undefined
  try { const info = await lstat(file); bytes = info.size; if (bytes) lastWrite = info.mtimeMs }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
  return { enabled: isEnabled, path: file, bytes, lastWrite, error: errors.get(file) }
}

export type Record = { timestamp: number; sessionID: string; role: string; eventType: string; data: unknown }
/** One ordered file for every session in the exact owning project. One bounded backup, no network. */
export async function record(directory: string, event: Record, maxBytes = MAX_BYTES) {
  const file = logPath(directory)
  const previous = locks.get(file) ?? Promise.resolve()
  const next = previous.catch(() => {}).then(async () => {
    if (!await enabled(directory)) return
    await directoryReady(directory)
    await noLink(file)
    await noLink(file + ".1")
    let line = JSON.stringify(redact(event)) + "\n"
    if (Buffer.byteLength(line) > Math.min(maxBytes, 256 * 1024)) line = JSON.stringify(redact({ timestamp: event.timestamp, sessionID: event.sessionID, role: event.role, eventType: event.eventType, omitted: "event exceeds recording limit" })) + "\n"
    let before = await lstat(file).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error
      return undefined
    })
    if (before && (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1))
      throw Error("Debug recording requires a private regular file")
    if (before?.size && before.size + Buffer.byteLength(line) > maxBytes) {
      await rename(file, file + ".1")
      before = undefined
    }
    const handle = await open(file, constants.O_WRONLY | constants.O_APPEND | (before ? 0 : constants.O_CREAT | constants.O_EXCL) | (constants.O_NOFOLLOW ?? 0), 0o600)
    try {
      const info = await handle.stat()
      if (!info.isFile() || info.nlink !== 1 || (before && (before.ino !== info.ino || before.dev !== info.dev)))
        throw Error("Debug recording requires an unchanged private regular file")
      // Validate the opened object before any mutation, including chmod.
      await handle.chmod(0o600)
      await handle.writeFile(line)
      errors.delete(file)
    } finally { await handle.close() }
  })
  locks.set(file, next)
  try { await next } catch (error) { failed(directory); throw error } finally { if (locks.get(file) === next) locks.delete(file) }
}
