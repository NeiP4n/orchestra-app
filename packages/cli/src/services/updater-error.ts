import { AppProcess } from "@orchestra/util/process"
import { stripVTControlCharacters } from "node:util"
import { errorMessage } from "../util/error"

export function conciseDetail(input: string) {
  const lines = stripVTControlCharacters(input)
    .trim()
    .replaceAll("\r", "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
  const tail = lines.slice(-12).join("\n")
  const clipped = tail.length > 2_000
  const detail = clipped ? `…${tail.slice(-1_999)}` : tail
  if (!detail) return
  if (lines.length <= 12 && !clipped) return detail
  return `${detail}\n\nOutput shortened to the last 12 lines.`
}

function outputDetail(value: unknown) {
  if (typeof value === "string") return conciseDetail(value)
  if (value instanceof Uint8Array) return conciseDetail(new TextDecoder().decode(value))
}

export function errorDetail(cause: unknown): string {
  if (cause instanceof AppProcess.AppProcessError) {
    const stderr = conciseDetail(cause.stderr ?? "")
    if (stderr) return stderr
    if (cause.cause !== undefined) return errorDetail(cause.cause)
    return cause.message
  }
  // Bun shell commands throw an Error whose useful stdout/stderr are properties,
  // while message is merely "Failed with exit code 1". Preserve the actual cause.
  if (typeof cause === "object" && cause !== null) {
    const stderr = outputDetail("stderr" in cause ? cause.stderr : undefined)
    if (stderr) return stderr
    const stdout = outputDetail("stdout" in cause ? cause.stdout : undefined)
    if (stdout) return stdout
  }
  if (cause instanceof Error) {
    const detail = cause.cause === undefined ? undefined : errorDetail(cause.cause)
    if (!detail || detail === cause.message) return cause.message
    return `${cause.message}: ${detail}`
  }
  return errorMessage(cause)
}
