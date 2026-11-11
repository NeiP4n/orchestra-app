export * as ScheduleRequests from "./schedule-requests.js"
import { mkdirSync, readFileSync, renameSync, writeFileSync, rmSync } from "node:fs"
import { randomUUID } from "node:crypto"
import path from "node:path"
import { Global } from "@orchestra/util/global"
import { ScheduleView } from "./schedule-view.js"
export interface Command {
  id: string
  sessionID: string
  requestID: string
  action: "pause" | "resume" | "export"
  reviewedDigest?: string
}
export interface Result {
  requestID: string
  ok: boolean
  message: string
}
const file = (id: string, kind: string) =>
  path.join(Global.Path.data, "schedule-requests", `${encodeURIComponent(id)}.${kind}.json`)
function write(id: string, kind: string, value: unknown) {
  const target = file(id, kind),
    temporary = `${target}.${process.pid}.${randomUUID()}.tmp`
  mkdirSync(path.dirname(target), { recursive: true })
  writeFileSync(temporary, JSON.stringify(value))
  renameSync(temporary, target)
}
/** Local operator UI only; the scheduler must verify the current KV owner before execution. */
export function request(id: string, sessionID: string, action: Command["action"]) {
  if (!ScheduleView.list(sessionID).some((item) => item.id === id)) throw Error("Триггер не найден в этом чате.")
  const request: Command = { id, sessionID, action, requestID: randomUUID() }
  write(id, "command", request)
  return request
}
/** Each selected entry was reviewed by the local operator. No grant or cap is changed. */
export function requestReviewedResume(id: string, sessionID: string, digest: string) {
  const item = ScheduleView.list(sessionID).find((item) => item.id === id)
  if (!item || item.enabled || !/^[a-f0-9]{64}$/.test(digest) || item.review?.digest !== digest)
    throw Error("Триггер изменился после проверки. Проверьте заново.")
  const request: Command = { id, sessionID, action: "resume", requestID: randomUUID(), reviewedDigest: digest }
  write(id, "command", request)
  return request
}
export function read(id: string, sessionID: string): Command | undefined {
  try {
    const value = JSON.parse(readFileSync(file(id, "command"), "utf8")) as Command
    if (
      value.id === id &&
      value.sessionID === sessionID &&
      typeof value.requestID === "string" &&
      /^[a-f0-9-]{36}$/.test(value.requestID) &&
      ["pause", "resume", "export"].includes(value.action) &&
      (value.reviewedDigest === undefined || (value.action === "resume" && /^[a-f0-9]{64}$/.test(value.reviewedDigest)))
    )
      return value
  } catch {}
}
export function finish(command: Command, ok: boolean, message: string) {
  write(command.id, "result", { requestID: command.requestID, ok, message } satisfies Result)
  if (read(command.id, command.sessionID)?.requestID === command.requestID)
    rmSync(file(command.id, "command"), { force: true })
}
export function result(command: Command): Result | undefined {
  try {
    const value = JSON.parse(readFileSync(file(command.id, "result"), "utf8")) as Result
    if (value.requestID === command.requestID && typeof value.ok === "boolean" && typeof value.message === "string")
      return value
  } catch {}
}
