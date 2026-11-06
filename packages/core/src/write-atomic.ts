export * as WriteAtomic from "./write-atomic.js"

import { randomUUID } from "node:crypto"
import { mkdir, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"

/**
 * Replaces one file in one atomic step: a temporary file beside the
 * destination is written and renamed over it, so a crash or a full disk
 * leaves the previous file intact. Shared by the `.orchestra` writers
 * (handoff, ADR, sprint, contracts) and the skill marketplace — every one
 * of them used to write in place, where an interrupted write left a torn
 * file that the next read took for truth (A3-16). A failed write removes
 * its temp file and throws; it never touches the destination.
 */
export async function writeAtomic(destination: string, contents: string): Promise<void> {
  await mkdir(path.dirname(destination), { recursive: true })
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, contents)
    await rename(temporary, destination)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}
