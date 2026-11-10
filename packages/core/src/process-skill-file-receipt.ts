export * as ProcessSkillFileReceipt from "./process-skill-file-receipt.js"

import { constants } from "node:fs"
import { lstat, mkdir, open, readdir, realpath } from "node:fs/promises"
import path from "node:path"
import { isDeepStrictEqual } from "node:util"
import { Effect } from "effect"
import type { KV } from "./kv.js"
import { ProcessSkillDefinitions as Definitions } from "./process-skill-definitions.js"
import { Flock } from "@orchestra/util/flock"
import { ProcessSkills } from "./process-skills.js"
import { ProcessSkillFiles as Files } from "./process-skill-files.js"
import { ProjectTemplateV2 as V2 } from "./project-template-v2.js"
import { ProjectTemplateV2Source as Source } from "./project-template-v2-source.js"

export const MARKER = ".orchestra-process-import.json"
export interface Owner {
  id: string
  sourceDigest: string
}
export function preview(
  dataDirectory: string,
  registry: ProcessSkills.Registry,
  input: readonly V2.Skill[],
  owner: Owner,
) {
  if (
    !/^pti_[A-Za-z0-9_-]{1,100}$/.test(owner.id) ||
    !/^[a-f0-9]{64}$/.test(owner.sourceDigest) ||
    Object.keys(owner).length !== 2
  )
    throw Error("Exact owning process receipt required")
  const plan = Files.preview(dataDirectory, registry, input)
  const marker =
    JSON.stringify({
      version: 1,
      id: owner.id,
      projectID: registry.projectID,
      sourceDigest: owner.sourceDigest,
      definitionsDigest: plan.digest,
    }) + "\n"
  return { ...plan, marker, digest: V2.hash(marker) }
}
async function directory(target: string) {
  const info = await lstat(target)
  if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(target)) !== target)
    throw Error("Process receipt directories must not use links")
  return info
}
async function readExact(target: string, expected: string) {
  const before = await lstat(target)
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size !== Buffer.byteLength(expected))
    throw Error("Process receipt file differs from its reservation")
  const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const opened = await handle.stat()
    if (opened.ino !== before.ino || opened.dev !== before.dev || opened.nlink !== 1)
      throw Error("Process receipt file changed")
    const buffer = Buffer.alloc(before.size + 1)
    let length = 0
    while (length < buffer.length) {
      const read = await handle.read(buffer, length, buffer.length - length, length)
      if (!read.bytesRead) break
      length += read.bytesRead
    }
    const after = await handle.stat(),
      current = await lstat(target)
    if (
      length !== before.size ||
      !buffer.subarray(0, length).equals(Buffer.from(expected)) ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      current.ino !== before.ino ||
      current.dev !== before.dev ||
      current.isSymbolicLink() ||
      (await realpath(target)) !== target
    )
      throw Error("Process receipt file changed")
  } finally {
    await handle.close()
  }
}
async function writeNew(target: string, content: string) {
  const file = await open(
    target,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
    0o600,
  )
  try {
    await file.writeFile(content, "utf8")
    await file.sync()
  } finally {
    await file.close()
  }
  await readExact(target, content)
}

/** Resumes only an exact owner marker and already-reviewed file set, never adopts a foreign folder or overwrites a file. */
export async function ensure(
  dataDirectory: string,
  registry: ProcessSkills.Registry,
  input: readonly V2.Skill[],
  owner: Owner,
  reviewedDigest: string,
) {
  const plan = preview(dataDirectory, registry, input, owner)
  if (reviewedDigest !== plan.digest) throw Error("Process file receipt changed after review")
  await directory(dataDirectory)
  return Flock.withLock(
    path.join(dataDirectory, "process-skills-" + V2.hash(registry.projectID).slice(0, 16) + ".lock"),
    async () => {
      const parent = path.dirname(plan.directory)
      try {
        await mkdir(parent, { mode: 0o700 })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      }
      await directory(parent)
      let fresh = false
      try {
        await mkdir(plan.directory, { mode: 0o700 })
        fresh = true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      }
      const reservation = await directory(plan.directory)
      const marker = path.join(plan.directory, MARKER)
      if (fresh) await writeNew(marker, plan.marker)
      else await readExact(marker, plan.marker)
      const allowedFiles = new Map<string, string>([[MARKER, plan.marker]])
      const allowedDirectories = new Set<string>()
      for (const definition of plan.definitions) {
        allowedDirectories.add(definition.skill.id)
        for (const file of definition.skill.files) {
          const relative = definition.skill.id + "/" + file.path
          allowedFiles.set(relative, file.content)
          const parts = relative.split("/")
          for (let i = 1; i < parts.length; i++) allowedDirectories.add(parts.slice(0, i).join("/"))
        }
      }
      const unchanged = async () => {
        await directory(dataDirectory)
        await directory(parent)
        const current = await directory(plan.directory)
        if (current.ino !== reservation.ino || current.dev !== reservation.dev)
          throw Error("Process file reservation changed")
        await readExact(marker, plan.marker)
      }
      const verifyExisting = async (relative = ""): Promise<void> => {
        const target = path.join(plan.directory, relative)
        await directory(target)
        const entries = await readdir(target)
        if (entries.length > 401) throw Error("Process file inventory exceeds its reservation")
        for (const entry of entries) {
          const child = relative ? relative + "/" + entry : entry
          if (allowedDirectories.has(child)) await verifyExisting(child)
          else if (allowedFiles.has(child)) await readExact(path.join(plan.directory, child), allowedFiles.get(child)!)
          else throw Error("Foreign file in process reservation; nothing was overwritten")
        }
      }
      await unchanged()
      await verifyExisting()
      for (const relative of [...allowedDirectories].sort((a, b) => a.split("/").length - b.split("/").length)) {
        await unchanged()
        const target = path.join(plan.directory, relative)
        await directory(path.dirname(target))
        try {
          await mkdir(target, { mode: 0o700 })
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
        }
        await directory(target)
      }
      for (const [relative, content] of allowedFiles) {
        if (relative === MARKER) continue
        await unchanged()
        const target = path.join(plan.directory, relative)
        await directory(path.dirname(target))
        try {
          await writeNew(target, content)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
          await readExact(target, content)
        }
      }
      for (const definition of plan.definitions) {
        const files = await Source.readSkillFiles(
          definition.root,
          definition.skill.files.map((file) => file.path),
        )
        if (JSON.stringify(files) !== JSON.stringify(definition.skill.files))
          throw Error("Process files differ after materialization")
      }
      await unchanged()
      await verifyExisting()
      return plan
    },
  )
}

/** Pure verification for the publication gate. It never repairs or writes a missing checkpoint. */
export async function verify(
  dataDirectory: string,
  registry: ProcessSkills.Registry,
  input: readonly V2.Skill[],
  owner: Owner,
  reviewedDigest: string,
) {
  const plan = preview(dataDirectory, registry, input, owner)
  if (plan.digest !== reviewedDigest) throw Error("Process file receipt changed after review")
  await directory(dataDirectory)
  await directory(path.dirname(plan.directory))
  await directory(plan.directory)
  await readExact(path.join(plan.directory, MARKER), plan.marker)
  const files = new Map<string, string>([[MARKER, plan.marker]])
  const directories = new Set<string>()
  for (const definition of plan.definitions) {
    directories.add(definition.skill.id)
    for (const file of definition.skill.files) {
      const relative = definition.skill.id + "/" + file.path
      files.set(relative, file.content)
      const parts = relative.split("/")
      for (let i = 1; i < parts.length; i++) directories.add(parts.slice(0, i).join("/"))
    }
  }
  const inspect = async (relative = ""): Promise<void> => {
    const target = path.join(plan.directory, relative)
    await directory(target)
    const entries = await readdir(target)
    if (entries.length > 401) throw Error("Process file inventory exceeds its reservation")
    for (const entry of entries) {
      const child = relative ? relative + "/" + entry : entry
      if (directories.has(child)) await inspect(child)
      else if (files.has(child)) await readExact(path.join(plan.directory, child), files.get(child)!)
      else throw Error("Foreign file in process reservation")
    }
  }
  await inspect()
  for (const [relative, content] of files) await readExact(path.join(plan.directory, relative), content)
  return plan
}

/** Live idempotent phase for an unpublished import. The caller still owns publication and dependency checks. */
export const install = Effect.fn("ProcessSkillFileReceipt.install")(function* (
  kv: KV.Interface,
  dataDirectory: string,
  registry: ProcessSkills.Registry,
  input: readonly V2.Skill[],
  owner: Owner,
  reviewedDigest: string,
) {
  const current = ProcessSkills.parse(yield* kv.get(ProcessSkills.PREFIX + registry.projectID), registry.projectID)
  if (!current || !isDeepStrictEqual(current, registry))
    return yield* Effect.die(new Error("Process assignments differ from the reserved source"))
  const planned = preview(dataDirectory, registry, input, owner)
  if (planned.digest !== reviewedDigest) return yield* Effect.die(new Error("Process receipt changed after review"))
  const expected = Definitions.preview(registry, planned.definitions)
  const existing = yield* kv.get(Definitions.PREFIX + registry.projectID)
  if (existing !== undefined && !isDeepStrictEqual(existing, expected.snapshot))
    return yield* Effect.die(new Error("Process definitions differ from the reserved source"))
  const written = yield* Effect.promise(() => ensure(dataDirectory, registry, input, owner, reviewedDigest))
  if (existing === undefined) {
    const saved = yield* Definitions.install(kv, registry, written.definitions, expected.digest).pipe(Effect.exit)
    // Another confirmation may have committed the exact definition after our read.
    if (saved._tag === "Failure") {
      if (!isDeepStrictEqual(yield* kv.get(Definitions.PREFIX + registry.projectID), expected.snapshot))
        return yield* saved
      const verified = yield* Definitions.load(kv, {
        projectID: registry.projectID,
        registry,
        allowed: new Set(registry.skills.map((skill) => skill.id)),
      })
      if (!verified || verified.length !== expected.snapshot.definitions.length) return yield* saved
    }
  }
  return written
})
