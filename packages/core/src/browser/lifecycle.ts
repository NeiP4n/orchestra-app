export * as BrowserLifecycle from "./lifecycle.js"
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"
import { Global } from "@orchestra/util/global"
const file = () => path.join(Global.Path.data, "browser-profiles", "retired-chats.json")
export function retired(chat: string): boolean {
  try { return JSON.parse(readFileSync(file(), "utf8")).includes(chat) }
  catch (error) {
    // A missing projection predates this guard. A corrupt/unreadable one must not permit a send.
    return (error as NodeJS.ErrnoException).code !== "ENOENT"
  }
}
/** Operator-owned local lifecycle projection, never inferred from an agent's title or page text. */
export function publish(retired: readonly string[], active: readonly string[]) {
  const alive = new Set(active)
  const text = JSON.stringify([...new Set(retired)].filter((id) => !alive.has(id)))
  const target = file()
  try { if (readFileSync(target, "utf8") === text) return } catch {}
  mkdirSync(path.dirname(target), { recursive: true })
  const tmp = `${target}.${process.pid}.tmp`
  writeFileSync(tmp, text)
  renameSync(tmp, target)
}
