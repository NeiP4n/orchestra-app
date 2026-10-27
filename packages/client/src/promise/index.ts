import type { Orchestra } from "./client.js"

export * from "./generated/index.js"
export { OpenCode, Orchestra } from "./client.js"
export type {
  AgentApi,
  CommandApi,
  ConfigApi,
  EventApi,
  IntegrationApi,
  ModelApi,
  PluginApi,
  ProviderApi,
  ReferenceApi,
  RpcApi,
  RpcCallOptions,
  RpcClient,
  RpcEventPayload,
  WebSearchApi,
  SessionApi,
  SkillApi,
} from "./api.js"
export type { EventSubscribeOutput as OpenCodeEvent, EventSubscribeOutput as OrchestraEvent } from "./generated/types.js"
export type OrchestraClient = ReturnType<typeof Orchestra.make>
export type OpenCodeClient = OrchestraClient
export * from "../event-source.js"
