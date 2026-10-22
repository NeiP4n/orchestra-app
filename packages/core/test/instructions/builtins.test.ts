import { describe, expect } from "bun:test"
import os from "os"
import { Effect, Layer } from "effect"
import { TestClock } from "effect/testing"
import { AppNodeBuilder } from "@orchestra/core/effect/app-node-builder"
import { Location } from "@orchestra/core/location"
import { FSUtil } from "@orchestra/util/fs-util"
import { Global } from "@orchestra/util/global"
import { AbsolutePath } from "@orchestra/core/schema"
import { InstructionBuiltIns } from "@orchestra/core/instructions/builtins"
import { location } from "../fixture/location"
import { testEffect } from "../lib/effect"
import { readInitial, readUpdate } from "../lib/instructions"

const directory = AbsolutePath.make(FSUtil.resolve("/repo/packages/core"))
const projectDirectory = AbsolutePath.make(FSUtil.resolve("/repo"))
const timestamp = Date.parse("2026-06-03T12:00:00.000Z")
const temporary = os.tmpdir()
const localDate = (time: number) => new Date(time).toDateString()
const locationLayer = Layer.succeed(
  Location.Service,
  Location.Service.of(
    location(
      { directory },
      { projectDirectory, vcs: { type: "git", store: AbsolutePath.make(FSUtil.resolve("/repo/.git")) } },
    ),
  ),
)
const it = testEffect(
  AppNodeBuilder.build(InstructionBuiltIns.node, [
    Location.node.replace(locationLayer),
    Global.node.replace(Global.layerWith({ config: temporary, tmp: temporary })),
  ]),
)

describe("InstructionBuiltIns", () => {
  it.effect("loads location-scoped environment and host-local date instructions", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(timestamp)
      const context = yield* InstructionBuiltIns.Service
      const initialized = yield* readInitial(yield* context.load())

      expect(initialized.text).toBe(
        [
          `Today's date: ${localDate(timestamp)}`,
          "",
          "<notes>",
          "  Notes are markdown files in .opencode/notes/, one file per note; the file name is the note id.",
          "  Write a note when a plan, decision, spec or summary has to outlive this chat.",
          "  Do not write a note that only restates the chat or answers a trivial question.",
          "  Every note has its own dedicated chat, opened from the Notes panel; requests in that chat are edits to the note.",
          "</notes>",
          "",
          "<skill-catalog>",
          "  At the start of a new task, check with skill_catalog whether SkillsMP already has a skill for it; do not wait to be asked.",
          "  Write the query in English, a few words naming the task: catalog descriptions are English, so translate a request that arrived in another language before searching.",
          "  search is cheap and settles whether a skill fits. get reads the skill text and earns its call only when you would really work by that skill.",
          "  A hit is a lead, not a detour: applying a skill never replaces doing the task itself.",
          "  Skip the catalog for trivial, everyday work where a published skill is unlikely to exist, or every small thing spends a call.",
          "</skill-catalog>",
          "",
          "Here is some useful information about the environment you are running in:",
          "<env>",
          `  Working directory: ${directory}`,
          `  Workspace root folder: ${projectDirectory}`,
          "  Is directory a git repo: yes",
          `  Platform: ${process.platform}`,
          `  Prefer ${temporary} over generic system temporary directories such as /tmp; it is pre-created and approved for external access.`,
          "</env>",
        ].join("\n"),
      )
    }),
  )

  it.effect("updates the date without repeating unchanged environment instructions", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(timestamp)
      const context = yield* InstructionBuiltIns.Service
      const initialized = yield* readInitial(yield* context.load())

      yield* TestClock.setTime(timestamp + 24 * 60 * 60 * 1000)
      const refreshed = yield* readUpdate(yield* context.load(), initialized)

      expect(refreshed.text).toBe(`Today's date is now: ${localDate(timestamp + 24 * 60 * 60 * 1000)}`)
    }),
  )

  it.effect("does not update again within the same local calendar day", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(timestamp)
      const context = yield* InstructionBuiltIns.Service
      const initialized = yield* readInitial(yield* context.load())

      yield* TestClock.setTime(timestamp + 60 * 60 * 1000)
      expect((yield* readUpdate(yield* context.load(), initialized)).changed).toBe(false)
    }),
  )
})
