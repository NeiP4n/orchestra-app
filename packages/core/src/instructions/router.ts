export * as InstructionRouter from "./router.js"

import { readdirSync } from "node:fs"
import path from "node:path"
import type { SessionMessage } from "../session/message.js"

// A project's AGENTS.md often holds rules for one part of the codebase (the session core, the TUI)
// next to rules for everything. Every request carries the whole file, so a session that never
// touches that part pays for its rules on every step. A `##` section whose heading names an area
// of the project (a top-level directory or one directly below it, such as packages/core) is sent
// as one index line until the session works there: it reads, edits or searches a path in that
// area, runs a command naming it, or the person's words name it. Then the full section joins the
// instructions as an update and stays for the rest of the session, since history only grows.
// Short sections and sections no area claims are always sent whole.

// ORCHESTRA_INSTRUCTION_ROUTER=off sends every section whole, as before routing existed.
export const enabled = () => process.env.ORCHESTRA_INSTRUCTION_ROUTER !== "off"

const MIN_SECTION = 600
const IGNORED = new Set(["node_modules", "dist", "build", "out", "target", "vendor"])

export type Area = { readonly name: string; readonly path: string }

/** Directories one and two levels below the project root, named the way a heading would name them. */
export function areas(root: string): Area[] {
  const children = (relative: string) => {
    try {
      return readdirSync(path.join(root, relative), { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && !IGNORED.has(entry.name))
        .map((entry) => (relative ? `${relative}/${entry.name}` : entry.name))
    } catch {
      return []
    }
  }
  return children("")
    .flatMap((top) => [top, ...children(top)])
    .map((item) => ({ name: item.split("/").at(-1)!.toLowerCase(), path: item }))
    // A version folder (specs/v2) names no area: "V2" in a heading is a generation, not a place.
    .filter((area) => !/^v\d+$/.test(area.name))
}

/** What a session has touched so far: paths and commands from its tool calls, and the person's words. */
export function activity(messages: ReadonlyArray<SessionMessage.Info>, directory: string) {
  return {
    texts: messages.flatMap((message) => (message.type === "user" ? [message.text] : [])),
    paths: [
      directory,
      ...messages.flatMap((message) =>
        message.type === "assistant"
          ? message.content.flatMap((part) => (part.type === "tool" && "input" in part.state ? [JSON.stringify(part.state.input)] : []))
          : [],
      ),
    ].map((item) => item.replaceAll("\\\\", "/").replaceAll("\\", "/").toLowerCase()),
  }
}

export function route(content: string, input: { areas: ReadonlyArray<Area>; texts: ReadonlyArray<string>; paths: ReadonlyArray<string> }) {
  const sections = split(content)
  const deferred = sections.flatMap((section) => {
    if (section.heading === undefined || section.text.length < MIN_SECTION) return []
    const words = new Set(section.heading.toLowerCase().match(/[\p{L}\p{N}-]+/gu) ?? [])
    const claimed = input.areas.filter((area) => words.has(area.name))
    if (claimed.length === 0 || claimed.some((area) => active(area, input))) return []
    return [{ section, claimed }]
  })
  if (deferred.length === 0) return content
  const skipped = new Set(deferred.map((item) => item.section))
  return [
    ...sections.filter((section) => !skipped.has(section)).map((section) => section.text.trimEnd()),
    [
      "## Area-specific sections",
      "",
      "These sections of this file load here on their own once the session works in their area: reads, edits or searches files there, runs a command naming it, or the task names it.",
      "",
      ...deferred.map((item) => `- ${item.section.heading} → ${item.claimed.map((area) => area.path).join(", ")}`),
    ].join("\n"),
  ].join("\n\n")
}

function split(content: string) {
  const lines = content.split("\n")
  const starts = lines.flatMap((line, index) => (/^## /.test(line) ? [index] : []))
  const head = starts[0] ?? lines.length
  return [
    ...(head > 0 ? [{ heading: undefined, text: lines.slice(0, head).join("\n") }] : []),
    ...starts.map((start, index) => ({
      heading: lines[start]!.slice(3).trim() as string | undefined,
      text: lines.slice(start, starts[index + 1] ?? lines.length).join("\n"),
    })),
  ]
}

function active(area: Area, input: { texts: ReadonlyArray<string>; paths: ReadonlyArray<string> }) {
  const target = area.path.toLowerCase()
  const word = new RegExp(`(^|[^\\p{L}\\p{N}_-])${area.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\p{L}\\p{N}_-])`, "iu")
  return (
    input.paths.some((item) => item.includes(`${target}/`) || item.endsWith(target) || item.includes(`${target}"`)) ||
    input.texts.some((text) => !text.trimStart().startsWith("<") && word.test(text))
  )
}
