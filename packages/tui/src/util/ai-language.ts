import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { Global } from "@orchestra/util/global"

export type AiLanguage = "auto" | "ru" | "en"

const START = "<!-- orchestra:ai-language -->"
const END = "<!-- /orchestra:ai-language -->"

const INSTRUCTION: Record<Exclude<AiLanguage, "auto">, string> = {
  ru: "Always think, reason and answer only in Russian, whatever language the user writes in. Keep code, identifiers, commands, file paths and quoted text exactly as they are.",
  en: "Always think, reason and answer only in English, whatever language the user writes in. Keep code, identifiers, commands, file paths and quoted text exactly as they are.",
}

// The core reads the global AGENTS.md as standing instructions for every session and picks up
// edits while sessions run, so the language choice lives there as one marked block. Everything
// else in the file belongs to the user and is left exactly as it was.
export async function applyAiLanguage(language: AiLanguage) {
  const file = path.join(process.env.ORCHESTRA_CONFIG_DIR ?? Global.Path.config, "AGENTS.md")
  const before = await readFile(file, "utf8").catch(() => undefined)
  if (language === "auto" && !before?.includes(START)) return
  const rest = strip(before ?? "")
  const body = language === "auto" ? rest : [rest, `${START}\n${INSTRUCTION[language]}\n${END}`].filter(Boolean).join("\n\n")
  const next = body ? `${body}\n` : ""
  if (next === (before ?? "")) return
  // A file that only ever held this block goes away with it rather than lingering empty.
  if (!next.trim()) return before === undefined ? undefined : rm(file, { force: true })
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, next)
}

function strip(content: string) {
  const start = content.indexOf(START)
  if (start < 0) return content.trimEnd()
  const end = content.indexOf(END, start)
  const tail = end < 0 ? "" : content.slice(end + END.length)
  return (content.slice(0, start) + tail).replace(/\n{3,}/g, "\n\n").trim()
}
