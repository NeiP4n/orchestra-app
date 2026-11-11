import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  ftruncateSync,
  writeSync,
  mkdirSync,
} from "node:fs"
import path from "node:path"
import { randomUUID } from "node:crypto"

/** Opens the log once. Size checks and writes stay on that descriptor, not a replaceable pathname. */
export function openRotatingLog(file: string, limit: number, suffix = ".1") {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const fd = openSync(
    file,
    constants.O_RDWR | constants.O_CREAT | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0),
    0o600,
  )
  try {
    if (!fstatSync(fd).isFile()) throw Error("Log destination is not a regular file")
    if (fstatSync(fd).size > limit) {
      const snapshot = readFileSync(fd)
      const temporary = `${file}.${randomUUID()}.tmp`
      try {
        writeFileSync(temporary, snapshot, { flag: "wx", mode: 0o600 })
        renameSync(temporary, `${file}${suffix}`)
      } finally {
        try {
          unlinkSync(temporary)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
        }
      }
      ftruncateSync(fd, 0)
    }
    return fd
  } catch (error) {
    closeSync(fd)
    throw error
  }
}

export function appendLog(file: string, text: string, limit: number) {
  const fd = openRotatingLog(file, limit)
  try {
    writeSync(fd, text)
  } finally {
    closeSync(fd)
  }
}
