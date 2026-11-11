export * as ProcessSkillFiles from "./process-skill-files.js"

import { constants } from "node:fs"
import { lstat, mkdir, open, realpath } from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import type { KV } from "./kv.js"
import { ProcessSkills } from "./process-skills.js"
import { ProcessSkillDefinitions as Definitions } from "./process-skill-definitions.js"
import { ProjectTemplateV2 as V2 } from "./project-template-v2.js"
import { ProjectTemplateV2Source as Source } from "./project-template-v2-source.js"

/** Paths come only from the application data directory and validated project-local identities. */
export function preview(dataDirectory: string, registry: ProcessSkills.Registry, input: readonly V2.Skill[]) {
  if (!path.isAbsolute(dataDirectory) || path.resolve(dataDirectory) !== dataDirectory)
    throw Error("Absolute application data directory required")
  const assignments = ProcessSkills.parse(registry, registry.projectID)
  if (!assignments) throw Error("Invalid project skill assignments")
  const directory = path.join(dataDirectory, "process-skills", ProcessSkills.namespace(registry.projectID).slice(0, -1))
  const definitions = input.map((skill) => ({ skill, root: path.join(directory, skill.id) }))
  const checked = Definitions.preview(assignments, definitions)
  return { directory, definitions: checked.snapshot.definitions, digest: checked.digest }
}

async function checkedDirectory(directory: string) {
  const info = await lstat(directory)
  if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(directory)) !== directory)
    throw Error("Project skill directories must not use links")
  return info
}
async function child(parent: string, name: string) {
  await checkedDirectory(parent)
  const directory = path.join(parent, name)
  try {
    await mkdir(directory, { mode: 0o700 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
  }
  await checkedDirectory(directory)
  return directory
}

/** Create-only. Failure leaves inert bounded files, never deletes or overwrites any existing destination. */
export async function materialize(
  dataDirectory: string,
  registry: ProcessSkills.Registry,
  input: readonly V2.Skill[],
  reviewedDigest: string,
) {
  const plan = preview(dataDirectory, registry, input)
  if (reviewedDigest !== plan.digest) throw Error("Project skill files changed after review")
  await checkedDirectory(dataDirectory)
  const parent = await child(dataDirectory, "process-skills")
  // Only this exclusive mkdir reserves the project. Never reuse a previous or interrupted import.
  await mkdir(plan.directory, { mode: 0o700 })
  const reservation = await checkedDirectory(plan.directory)
  const unchanged = async () => {
    await checkedDirectory(dataDirectory)
    await checkedDirectory(parent)
    const current = await checkedDirectory(plan.directory)
    if (current.ino !== reservation.ino || current.dev !== reservation.dev)
      throw Error("Project skill destination changed during installation")
  }
  for (const definition of plan.definitions) {
    await unchanged()
    await mkdir(definition.root, { mode: 0o700 })
    await checkedDirectory(definition.root)
    for (const file of definition.skill.files) {
      const parts = file.path.split("/")
      let target = definition.root
      for (const segment of parts.slice(0, -1)) target = await child(target, segment)
      await unchanged()
      await checkedDirectory(target)
      const destination = path.join(target, parts.at(-1)!)
      const handle = await open(
        destination,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
        0o600,
      )
      try {
        const opened = await handle.stat()
        if (!opened.isFile() || opened.nlink !== 1) throw Error("Project skill file is not an exclusive regular file")
        await handle.writeFile(file.content, "utf8")
        await handle.sync()
        const current = await lstat(destination)
        if (current.ino !== opened.ino || current.dev !== opened.dev || current.isSymbolicLink() || current.nlink !== 1)
          throw Error("Project skill file changed during installation")
      } finally {
        await handle.close()
      }
      await unchanged()
    }
    const files = await Source.readSkillFiles(
      definition.root,
      definition.skill.files.map((file) => file.path),
    )
    if (JSON.stringify(files) !== JSON.stringify(definition.skill.files))
      throw Error("Project skill files failed verification")
  }
  await unchanged()
  return plan
}

/** Owning import workflow installs assignments first while its receipt is unpublished. This step does not publish it. */
export const install = Effect.fn("ProcessSkillFiles.install")(function* (
  kv: KV.Interface,
  dataDirectory: string,
  registry: ProcessSkills.Registry,
  input: readonly V2.Skill[],
  reviewedDigest: string,
) {
  const current = ProcessSkills.parse(yield* kv.get(ProcessSkills.PREFIX + registry.projectID), registry.projectID)
  if (!current || JSON.stringify(current) !== JSON.stringify(registry))
    return yield* Effect.die(new Error("Project skill assignments changed before file installation"))
  if ((yield* kv.get(Definitions.PREFIX + registry.projectID)) !== undefined)
    return yield* Effect.die(new Error("Project skill definitions already exist; nothing was overwritten"))
  const written = yield* Effect.promise(() => materialize(dataDirectory, registry, input, reviewedDigest))
  yield* Definitions.install(kv, registry, written.definitions, written.digest)
  return written
})
