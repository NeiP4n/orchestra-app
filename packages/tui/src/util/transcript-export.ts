import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

/** Export into a newly owned directory. Never follow a pre-created temporary filename. */
export async function writeTranscriptExport(content: string, format: "markdown" | "json") {
  const directory = await mkdtemp(path.join(tmpdir(), "orchestra-export-"))
  const file = path.join(directory, format === "markdown" ? "session.md" : "session.json")
  try {
    await writeFile(file, content, { flag: "wx", mode: 0o600 })
    return file
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}
