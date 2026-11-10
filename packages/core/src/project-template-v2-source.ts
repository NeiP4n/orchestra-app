export * as ProjectTemplateV2Source from "./project-template-v2-source.js"

import { constants } from "node:fs"
import { lstat, open, realpath } from "node:fs/promises"
import path from "node:path"
import { ProjectTemplateSource as V1Source } from "./project-template-source.js"
import { ProjectTemplateV2 as V2 } from "./project-template-v2.js"

export interface ProcessSource {
  playbook: string | null
  recommendedRoles: string[]
  roles: readonly V2.Role[]
  skills: readonly V2.Skill[]
  /** Persisted assignments, not skill recommendations recovered from chats. */
  skillAssignments: { target: { kind: "project" } | { kind: "role"; role: string } | { kind: "session"; sessionID: string }; skills: string[] }[]
  /** Every owned session must have an explicit snapshot, including an empty one. */
  sessionModels: { sessionID: string; models: V2.Model[] }[]
  programs: V2.Process["programs"]
}
/** Pure projection from already-owned metadata. Nothing is installed or launched. */
export function capture(source: V1Source.Source, metadata: Parameters<typeof V1Source.capture>[1], process: ProcessSource) {
  try {
    const base = V1Source.capture(source, metadata)
    if (!base.ok) throw Error()
    const sessions = new Map(source.sessions.map((s, i) => [s.id, `session_${i + 1}`]))
    const roleIDs = new Set([...source.sessions.map((s) => s.agent!), ...source.rules.filter((r) => r.scope === "role").map((r) => r.role!), ...process.recommendedRoles])
    const roles = new Map(process.roles.map((r) => [r.agent, r]))
    const skills = new Map(process.skills.map((s) => [s.id, s]))
    if (roles.size !== process.roles.length || skills.size !== process.skills.length || [...roleIDs].some((id) => !roles.has(id))) throw Error()
    const selected = new Set<string>(), visiting = new Set<string>()
    const select = (id: string) => {
      if (visiting.has(id)) throw Error()
      if (selected.has(id)) return
      const skill = skills.get(id); if (!skill) throw Error()
      visiting.add(id); skill.dependencies.forEach(select); visiting.delete(id); selected.add(id)
    }
    const skillAssignments = process.skillAssignments.map((r): V2.Process["skillAssignments"][number] => {
      if (r.target.kind === "session") {
        const session = sessions.get(r.target.sessionID); if (!session) throw Error()
        r.skills.forEach(select); return { target: { kind: "session", session }, skills: r.skills }
      }
      if (r.target.kind === "role" && !roleIDs.has(r.target.role)) throw Error()
      r.skills.forEach(select); return { target: r.target, skills: r.skills }
    })
    if (process.sessionModels.length !== sessions.size || new Set(process.sessionModels.map((r) => r.sessionID)).size !== sessions.size) throw Error()
    const sessionModels = process.sessionModels.map((r) => { const session = sessions.get(r.sessionID); if (!session) throw Error(); return { session, models: r.models } })
    return V2.preview(JSON.stringify({ ...base.value.bundle, version: 2, process: {
      playbook: process.playbook, recommendedRoles: process.recommendedRoles,
      roles: process.roles.filter((r) => roleIDs.has(r.agent)), skills: process.skills.filter((s) => selected.has(s.id)), skillAssignments, sessionModels, programs: process.programs,
    } }))
  } catch { return { ok: false as const, error: "Process definitions are incomplete or not portable. No template was prepared." } }
}
/** Caller supplies a definition-only file list from the skill's owning reader, never a project scan.
 * Each directory and file is checked. No symlinks, hardlinks, absolute paths, executable execution or binary decoding. */
export async function readSkillFiles(root: string, paths: readonly string[]): Promise<V2.Skill["files"]> {
  try {
    if (!path.isAbsolute(root) || paths.length === 0 || paths.length > V2.MAX_FILES || new Set(paths.map((s) => s.toLowerCase())).size !== paths.length) throw Error()
    const base = path.resolve(root), info = await lstat(base)
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(base) !== base) throw Error()
    const output: V2.Skill["files"] = []
    let bytes = 0
    for (const relative of paths) {
      V2.relativePath(relative)
      const parts = relative.split("/")
      for (let i = 1; i < parts.length; i++) {
        const parent = path.join(base, ...parts.slice(0, i)), stat = await lstat(parent)
        if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(parent) !== parent) throw Error()
      }
      const file = path.join(base, relative), before = await lstat(file)
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 65536) throw Error()
      const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      try {
        const opened = await handle.stat()
        if (opened.dev !== before.dev || opened.ino !== before.ino || !opened.isFile() || opened.nlink !== 1) throw Error()
        const buffer = Buffer.alloc(65537)
        let length = 0
        while (length < buffer.length) {
          const read = await handle.read(buffer, length, buffer.length - length, length)
          if (read.bytesRead === 0) break
          length += read.bytesRead
        }
        const after = await handle.stat(), current = await lstat(file)
        bytes += length
        if (bytes > V2.MAX_BYTES || length > 65536 || length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || current.dev !== before.dev || current.ino !== before.ino || current.isSymbolicLink() || await realpath(file) !== file) throw Error()
        const content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, length))
        if (content.includes("\0")) throw Error()
        output.push({ path: relative, content, sha256: V2.hash(content) })
      } finally { await handle.close() }
    }
    return output
  } catch { throw Error("Skill definition files cannot be captured safely. No template was prepared.") }
}
