// Fast, Effect-free entry point: `bun script/checkpoint.ts <action> [args]`.
// save [--name <name>] [--force] | list | preview <id|name> | restore <id|name> | delete <id|name> | gc

import { gc, list, preview, remove, restore, save } from "../packages/core/src/checkpoint/engine.js"
import {
  renderGc,
  renderList,
  renderPreview,
  renderRemove,
  renderRestore,
  renderSave,
} from "../packages/core/src/checkpoint/render.js"

const [action, ...rest] = process.argv.slice(2)
const root = process.cwd()

const flags = new Map<string, string | true>()
const positional: string[] = []
for (let index = 0; index < rest.length; index++) {
  const argument = rest[index]!
  if (!argument.startsWith("--")) {
    positional.push(argument)
    continue
  }
  const name = argument.slice(2)
  const next = rest[index + 1]
  if (next === undefined || next.startsWith("--")) {
    flags.set(name, true)
    continue
  }
  flags.set(name, next)
  index++
}

const name = flags.get("name")
const output = () => {
  switch (action) {
    case "save":
      return renderSave(
        save(root, { ...(typeof name === "string" ? { name } : {}), ...(flags.has("force") ? { force: true } : {}) }),
      )
    case "list":
      return renderList(list(root))
    case "preview":
      return renderPreview(preview(root, requireTarget()))
    case "restore":
      return renderRestore(restore(root, requireTarget()))
    case "delete":
      return renderRemove(remove(root, requireTarget()))
    case "gc":
      return renderGc(gc(root))
    default:
      throw new Error(usage())
  }
}

function requireTarget() {
  const target = positional[0]
  if (target === undefined) throw new Error(`this action needs a checkpoint id or name\n\n${usage()}`)
  return target
}

function usage() {
  return [
    "Usage: bun script/checkpoint.ts <action>",
    "  save [--name <name>] [--force]   record every path git reports as changed",
    "  list                             list checkpoints, newest first",
    "  preview <id|name>                what a restore would change",
    "  restore <id|name>                put the saved content back",
    "  delete <id|name>                 remove a checkpoint (objects stay until gc)",
    "  gc                               delete objects no checkpoint refers to",
  ].join("\n")
}

try {
  console.log(output())
} catch (error) {
  console.error(`checkpoint ${action ?? ""}: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
