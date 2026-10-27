/// <reference path="../markdown.d.ts" />

export * as SkillPlugin from "./skill.js"

import { define, type Context } from "@orchestra/plugin/effect/plugin"
import { Document } from "@orchestra/schema/config"
import { Effect } from "effect"
import { AbsolutePath } from "../schema.js"
import { Skill } from "../skill.js"
import { Config } from "../config.js"
import os from "os"
import opencodeContent from "./skill/opencode.md" with { type: "text" }
import reportContent from "./skill/report.md" with { type: "text" }
import hubContent from "./skill/hub.md" with { type: "text" }
import mcpContent from "./skill/mcp.md" with { type: "text" }
import autonomousDeveloperContent from "./skill/autonomous-developer.md" with { type: "text" }
import projectCreatorContent from "./skill/project-creator.md" with { type: "text" }

export const AutonomousDeveloperContent = autonomousDeveloperContent
export const ProjectCreatorContent = projectCreatorContent

const AUTONOMOUS_DEVELOPER_DESCRIPTION =
  "Use for end-to-end autonomous engineering, complex feature architecture, automated DoD generation, dynamic MCP tool acquisition, and hands-off implementation from a simple user prompt."
const PROJECT_CREATOR_DESCRIPTION =
  "Use when asked to scaffold, initialize, or bootstrap a new project, service, or repository from scratch with complete architecture and build setup."

export const OpencodeContent = opencodeContent
export const ReportContent = reportContent
export const HubContent = hubContent

export const McpContent = mcpContent
const MCP_DESCRIPTION =
  "Use when the task involves an installed MCP server (browser, documentation, git, GitHub, memory, desktop, reverse engineering) or when the operator asks to add or remove one. Covers discovering servers and tool names that change over time, granting them to team roles by pattern, and embedding them in a team template without breaking when a server disappears."

export const OpencodeDescription =
  "Use this skill for any question about Orchestra itself, including how Orchestra works, using or configuring it, migrating from V1 to V2, troubleshooting it, developing plugins or integrations, using the Orchestra SDK, clients, server, or API, and contributing to the Orchestra codebase. Also use it for Orchestra agents, commands, skills, tools, permissions, MCP servers, providers, models, themes, keybinds, formatters, the CLI, TUI, desktop app, and web app."
const REPORT_DESCRIPTION =
  "Use when the user wants to report an orchestra issue or bug. Collect standard diagnostics, add user-specific reproduction context, and publish the issue with GitHub CLI."
export const HubDescription =
  "Use when choosing how to run a search, file discovery, JSON or YAML, tabular data, git, docker, systemd, process or network inspection task. Covers picking a Universal Tool Hub catalog entry and its fast modern CLI over hand-written shell."

export const Plugin = define({
  id: "opencode.skill",
  effect: Effect.fn(function* (ctx) {
    const reportContent = yield* reportContentWithDiagnostics(ctx.app)
    yield* ctx.skill.transform((editor) => {
      editor.add(
        Skill.Info.make({
          id: Skill.ID.make("opencode"),
          name: Skill.Name.make("Orchestra"),
          description: OpencodeDescription,
          path: AbsolutePath.make("/builtin/opencode.md"),
          content: OpencodeContent,
        }),
      )
      editor.add(
        Skill.Info.make({
          id: Skill.ID.make("report"),
          name: Skill.Name.make("Report"),
          description: REPORT_DESCRIPTION,
          path: AbsolutePath.make("/builtin/report.md"),
          content: reportContent,
        }),
      )
      editor.add(
        Skill.Info.make({
          id: Skill.ID.make("hub"),
          name: Skill.Name.make("Tool Hub"),
          description: HubDescription,
          path: AbsolutePath.make("/builtin/hub.md"),
          content: HubContent,
        }),
      )
      editor.add(
        Skill.Info.make({
          id: Skill.ID.make("mcp"),
          name: Skill.Name.make("MCP instruments"),
          description: MCP_DESCRIPTION,
          path: AbsolutePath.make("/builtin/mcp.md"),
          content: McpContent,
        }),
      )
      editor.add(
        Skill.Info.make({
          id: Skill.ID.make("autonomous-developer"),
          name: Skill.Name.make("Autonomous Developer"),
          description: AUTONOMOUS_DEVELOPER_DESCRIPTION,
          path: AbsolutePath.make("/builtin/autonomous-developer.md"),
          content: AutonomousDeveloperContent,
        }),
      )
      editor.add(
        Skill.Info.make({
          id: Skill.ID.make("project-creator"),
          name: Skill.Name.make("Project Creator"),
          description: PROJECT_CREATOR_DESCRIPTION,
          path: AbsolutePath.make("/builtin/project-creator.md"),
          content: ProjectCreatorContent,
        }),
      )
    })
  }),
})

const reportContentWithDiagnostics = Effect.fn("SkillPlugin.reportContentWithDiagnostics")(function* (
  app: Context["app"],
) {
  const plugins = yield* configuredPlugins()
  return [
    ReportContent,
    "",
    "## Runtime Diagnostics Snapshot",
    "",
    "These values were captured when the built-in report skill was registered. Verify them before publishing.",
    "",
    `- orchestra version: ${app.version}`,
    `- install/channel: ${app.channel}`,
    `- OS: ${os.type()} ${os.release()} (${os.platform()} ${os.arch()})`,
    `- Terminal: ${terminal()}`,
    `- Shell: ${shell()}`,
    `- Active plugins: ${plugins.length === 0 ? "None found in config" : plugins.join(", ")}`,
  ].join("\n")
})

const configuredPlugins = Effect.fn("SkillPlugin.configuredPlugins")(function* () {
  const config = yield* Config.Service
  return (yield* config.entries())
    .filter((entry): entry is Document => entry.type === "document")
    .flatMap((entry) => entry.info.plugins ?? [])
    .map((entry) => (typeof entry === "string" ? entry : entry.package))
    .toSorted()
})

function terminal() {
  return (
    [
      process.env.TERM_PROGRAM ? `TERM_PROGRAM=${process.env.TERM_PROGRAM}` : undefined,
      process.env.TERM ? `TERM=${process.env.TERM}` : undefined,
      process.env.COLORTERM ? `COLORTERM=${process.env.COLORTERM}` : undefined,
    ]
      .filter((item): item is string => item !== undefined)
      .join(", ") || "Unavailable: terminal environment variables are not set"
  )
}

function shell() {
  return (
    process.env.SHELL ??
    process.env.ComSpec ??
    process.env.COMSPEC ??
    "Unavailable: shell environment variable is not set"
  )
}
