// TODO: Keep additional network capabilities inside Schema and Protocol as the client grows; /effect must never import
// Core or Server. Preserve these datatype exports so internal model reorganizations do not require caller migrations.
import type { Effect } from "effect"
import type { Orchestra } from "./client.js"

export * from "./generated/index"
export { OpenCode, Orchestra } from "./client.js"
export type {
  AgentApi,
  AppApi,
  CommandApi,
  ConfigApi,
  EventApi,
  IntegrationApi,
  ModelApi,
  PluginApi,
  ProviderApi,
  ReferenceApi,
  RpcApi,
  RpcClient,
  WebSearchApi,
  SessionApi,
  SkillApi,
} from "./api.js"
export { Agent } from "@orchestra/schema/agent"
export { Command } from "@orchestra/schema/command"
export { Config } from "@orchestra/schema/config"
export { Credential } from "@orchestra/schema/credential"
export { Event } from "@orchestra/schema/event"
export { EventLog } from "@orchestra/schema/event-log"
export { FileSystem } from "@orchestra/schema/filesystem"
export { Form } from "@orchestra/schema/form"
export { Integration } from "@orchestra/schema/integration"
export { Location } from "@orchestra/schema/location"
export { Model } from "@orchestra/schema/model"
export { Permission } from "@orchestra/schema/permission"
export { PermissionSaved } from "@orchestra/schema/permission-saved"
export { Project } from "@orchestra/schema/project"
export { Worktree } from "@orchestra/schema/worktree"
export { Vcs } from "@orchestra/schema/vcs"
export { Provider } from "@orchestra/schema/provider"
export { Pty } from "@orchestra/schema/pty"
export { Question } from "@orchestra/schema/question"
export { Reference } from "@orchestra/schema/reference"
export { WebSearch } from "@orchestra/schema/websearch"
export { AbsolutePath, RelativePath } from "@orchestra/schema/schema"
export { Session } from "@orchestra/schema/session"
export { SessionInbox } from "@orchestra/schema/session-inbox"
export { SessionMessage } from "@orchestra/schema/session-message"
export { Skill } from "@orchestra/schema/skill"
export { Prompt } from "@orchestra/schema/prompt"
export { PromptInput } from "@orchestra/schema/prompt-input"
export type { OpenCodeEvent, OrchestraEvent } from "@orchestra/protocol/groups/event"
export type OrchestraClient = Effect.Success<ReturnType<typeof Orchestra.make>>
export type OpenCodeClient = OrchestraClient
