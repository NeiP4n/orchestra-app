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
          "  Notes are markdown files in .orchestra/notes/, one file per note; the file name is the note id.",
          "  Existing notes in .opencode/notes/ are read as a fallback; new and updated notes are saved in .orchestra/notes/.",
          "  Write a note when a plan, decision, spec or summary has to outlive this chat.",
          "  Do not write a note that only restates the chat or answers a trivial question.",
          "  Every note has its own dedicated chat, opened from the Notes panel; requests in that chat are edits to the note.",
          "</notes>",
          "",
          "<skill-catalog>",
          "  At the start of a new task, check with skill_catalog whether SkillsMP already has a skill for it; do not wait to be asked.",
          "  Write the query in English, a few words naming the task: catalog descriptions are English, so translate a request that arrived in another language before searching.",
          "  search is cheap and settles whether a skill fits. get reads the skill text and earns its call only when you would really work by that skill.",
          "  Before you get a skill, scan it: scan checks the text for prompt injection, secret exfiltration and piped installers. get refuses a skill scored DO NOT INSTALL, and a CAUTION one needs a reason you give the user.",
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
          "",
          "<tool-routing>",
          "Intent-to-Tool Routing:",
          "- Code search & AST navigation -> symbols, grep, glob: Pinpoint definitions, signatures and usages before reading files; avoid blind full-file reads.",
          "- Git & VCS operations -> git_*, hub: Prefer dedicated MCP git tools or hub recipes over hand-written shell pipelines.",
          "- Library documentation & external APIs -> context7: Query context7 (resolve-library-id -> query-docs) instead of assuming obsolete API signatures.",
          "- Complex reasoning & architecture design -> sequential-thinking, memory: Structure hypotheses, step-by-step falsifications, and persist durable decisions in memory.",
          "- Background processes & long-running jobs -> desktop-commander: Use desktop-commander (start_process, read_process_output, interact_with_process, force_terminate) instead of blocking commands.",
          "- Live pages, web apps & browser flows -> browser, playwright_*, chrome-devtools_*, puppeteer_*: Drive the page with these instead of reconstructing it from a fetch or curl: open the URL, read the accessibility tree or DOM, act, then assert on the result. A rendered page is evidence; a guessed one is not.",
          "- Current information, unfamiliar libraries & APIs -> research, websearch, webfetch, deepwiki_*: Call research first: one call searches and reads the most relevant pages. Then read the primary source (official docs, changelog, source) before relying on the fact.",
          "- A capability missing from this request -> tools, execute: The advertised list is partial. Installed MCP servers and the other instruments appear as index lines, not as schemas. When the task needs a browser, GitHub, docs, a database or another MCP server, load it by name with `tools` (or find it inside `execute` with `search`) and use it on the next step instead of approximating it with shell commands.",
          "</tool-routing>",
          "",
          "<action-snippets>",
          "Parametrized shortcuts for common monorepo actions:",
          "- test-target [bun test packages/<pkg>/test/<name>.test.ts]: Run targeted test file directly without running the entire suite",
          "- package-typecheck [bun run typecheck (in packages/<pkg>)]: Fast package-scoped type checking via tsgo",
          "- workspace-check [bun run check (from repository root)]: Canonical full lint and typecheck verification across monorepo",
          "- client-generate [bun run generate (in packages/client)]: Regenerate client SDK after server/protocol HTTP API updates",
          "- bg-process [tools['desktop-commander'].start_process({ command, workdir }) -> read_process_output({ session_id })]: Execute interactive or long-running command asynchronously",
          "- narrow-search [grep({ pattern, path: '<dir>', include: '*.ts', limit: 30 })]: Token-efficient code search restricted to relevant file types and matches",
          "- bounded-read [read({ path: '<file>', offset: 1, limit: 60 })]: Read targeted file slice instead of spending context on massive files",
          "</action-snippets>",
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
