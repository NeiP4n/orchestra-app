export * as CheckpointTool from "./checkpoint.js"

import { ToolFailure } from "@orchestra/ai"
import type { Context } from "@orchestra/plugin/effect/plugin"
import { optional } from "@orchestra/schema/schema"
import { Effect, Schema } from "effect"
import { list, preview, restore, save } from "../../checkpoint/engine.js"
import { renderList, renderPreview, renderRestore, renderSave } from "../../checkpoint/render.js"
import { Location } from "../../location.js"

export const name = "checkpoint"

export const description = [
  "The project's time machine: save the working tree as a checkpoint and roll back to one later.",
  "",
  "Actions:",
  "  save — record every path git reports as changed (modified, added, untracked and deleted files). Give a name to find it again.",
  "  list — the checkpoints, newest first, with size on disk.",
  "  preview — what restoring a checkpoint would write, delete or leave alone, without touching a file.",
  "  restore — put the saved content back. Changed files are written, files the snapshot recorded as deleted are removed, and paths that are not in the snapshot stay untouched.",
  "",
  "Only changed files are stored, content-addressed and zstd-compressed, so node_modules and build output never enter a",
  "snapshot and an unchanged file costs nothing. A restore first saves the working tree as a safety checkpoint, so it",
  "can itself be undone with restore.",
].join("\n")

export const Input = Schema.Struct({
  action: Schema.Literals(["save", "restore", "list", "preview"]),
  /** Name for a new checkpoint. */
  name: optional(Schema.String),
  /** Checkpoint id, or its name, for restore and preview. */
  id: optional(Schema.String),
  /** Replace an existing checkpoint with the same name on save. */
  force: optional(Schema.Boolean),
})
export type Input = typeof Input.Type

export const Output = Schema.Struct({ output: Schema.String })
export type Output = typeof Output.Type

export const Plugin = {
  id: "orchestra.tool.checkpoint",
  effect: Effect.fn("CheckpointTool.Plugin")(function* (ctx: Context) {
    const location = yield* Location.Service

    const run = Effect.fn("CheckpointTool.run")(function* (input: Input) {
      const target = input.id?.trim() || input.name?.trim() || ""
      if ((input.action === "restore" || input.action === "preview") && target === "")
        return yield* new ToolFailure({ message: `checkpoint ${input.action} needs the id or name of a checkpoint.` })

      return yield* Effect.try({
        try: () => answer(location.project.directory, input, target),
        catch: (error) => new ToolFailure({ message: `checkpoint ${input.action} failed: ${message(error)}`, error }),
      })
    })

    yield* ctx.tool
      .transform((editor) =>
        editor.add({
          name,
          options: { codemode: false, core: true },
          description,
          input: Input,
          output: Output,
          execute: (input) => run(input).pipe(Effect.map((output) => ({ output: { output }, content: output }))),
        }),
      )
      .pipe(Effect.orDie)
  }),
}

function answer(root: string, input: Input, target: string) {
  if (input.action === "save")
    return renderSave(
      save(root, {
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.force === undefined ? {} : { force: input.force }),
      }),
    )
  if (input.action === "list") return renderList(list(root))
  if (input.action === "preview") return renderPreview(preview(root, target))
  return renderRestore(restore(root, target))
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
